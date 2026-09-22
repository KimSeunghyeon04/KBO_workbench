# 추가 병목 개선 결과

2026-09-13에 조사한 병목을 수정하고 로컬 API·웹에 반영했다. 현재 경기 4,698개(원장 4,694개,
약 2.00GB), staging 4,645개, quarantine 49개, source failure 4개의 같은 자료로 비교했다.
PostgreSQL에는 운영 봉인 경기가 없어 DB 적재·목록·재생 검증은 격리 PostgreSQL과 fixture를 사용했다.

## 측정 결과

| 경로                          |      이전 |   적용 후 | 측정 범위                                                   |
| ----------------------------- | --------: | --------: | ----------------------------------------------------------- |
| 전체 검증 후 서버 준비        |  약 219초 |   135.6초 | 로컬 Compose 재시작, 전체 current 검사                      |
| 수집 이력 상세                | 535~547ms |   35~51ms | 4개 작업, 각 3회 조회 중앙값                                |
| 32경기 적재 대상 확정         |   2,428ms |      31ms | 운영 자료를 복사한 격리 workspace, 3회 중앙값               |
| 대상 확정 중 원장 파일 읽기   |      64회 |       0회 | 검증된 정보와 최신 manifest를 대조; 실제 import 검증은 별도 |
| 큰 경기의 반복 원문 행 선택   | 276~304ms | 3.5~5.8ms | 같은 873행 경기, Chromium에서 서로 다른 5개 행 선택         |
| 큰 경기 session GET           |     111ms |    45.8ms | localhost 웹 프록시, 3회 중앙값                             |
| 큰 경기 명령 미리보기         |   236.5ms |     159ms | 같은 명령의 dry run, 3회 중앙값                             |
| 큰 경기 fact INSERT           |   6,225회 |      33회 | 같은 관계형 projection의 SQL 호출 수; 시간 추정 아님        |
| 큰 경기 replay의 전체 DB 로드 |       5회 |       1회 | manifest + 4개 page, 저장소 대역으로 호출 수 측정           |

중간·상위 95% 크기 표본도 replay 전체 로드가 4회에서 1회로 감소했다. 대역 저장소에서 bundle 생성과
page 응답을 합친 시간은 400~~523ms에서 129~~178ms로 줄었다. 이 수치는 실제 PostgreSQL 지연시간을
포함하지 않는다. SQL 목록 페이지 처리와 저장 후 hash·재컴파일·rollback은 실제 PostgreSQL에서
통합 테스트했다.

큰 경기의 작업 사본을 30회 열고 닫은 뒤 남은 서버 session은 0개였다. 강제 GC 후 heap 증가는
2.1MiB였으며, 이전처럼 30개를 계속 보관했을 때의 69.4MiB 누적을 피한다. 브라우저에서도 보정에서
대시보드로 이동하면 DELETE 204가 발생하고 해당 session GET은 404가 되는 것을 확인했다.

## 구현

- 교정: 저장 후 최신 version으로 DELETE, 명시적 닫기, clean session의 화면 이탈 정리, 미저장
  사본의 ID만 같은 탭에 보관해 복귀 시 다시 열기. 서버는 64개 상한과 생성 시 clean session의
  미사용 30분 회수를 적용한다. dirty session과 진행 중인 명령은 자동 회수하지 않는다.
- 교정 계산: 같은 version의 snapshot을 복제해 재사용한다. tracking context 보완이 문서를 바꾸지
  않았을 때만 직전 전체 컴파일을 재사용한다. 원본 비교는 문서 변경 시에만 실행한다.
- 원문: game/season/source hash가 같은 검증 완료 bundle을 최대 32MiB·8개·미사용 5분으로
  재사용한다. 웹 원문 조회 키에는 session version을 포함하고 이전 요청에 abort signal을 전달한다.
- 이력: 검증한 결과 행을 최대 32MiB·16개 작업으로 재사용한다. 쓰기 전후 무효화, 동시 읽기 공유,
  읽기 도중 변경 시 재조회로 현재 결과를 유지한다.
- 대상 확정: 검증된 revision/hash를 manifest 전체와 대조하고 변경된 경우 원장을 다시 검사한다.
  `readDocument`의 중복 읽기도 제거했다. 실제 import의 전체 compile·expected hash 검사는 유지한다.
- 시작: 64경기 이상은 최대 4개 worker로 같은 strict 검증을 수행한다. 검사 중에도 HTTP는
  liveness를 응답하며 readiness와 업무 API는 503으로 차단한다. 웹 조회만 준비 응답을 자동 재시도한다.
- DB: 목록 검색·시즌·정렬·페이지를 SQL로 처리하고, fact INSERT는 최대 500행·60,000 parameter로
  묶는다. descriptor 순서, 트랜잭션과 봉인 무결성 검사는 유지한다.
- 재생: 새 manifest는 항상 DB 검증을 수행하고 page는 그 검증된 불변 bundle을 최대
  64MiB·16개·미사용 60초로 재사용한다. cursor 검증과 응답 복제를 유지한다.
- 기록정정: 한 목록 요청 안에서 같은 경기의 작업본 읽기·차단 집계를 공유한다. 다음 요청에서는
  작업본과 DB base를 다시 확인한다.
- 전송: nginx에서 JSON·JS·CSS 등을 gzip으로 전송한다. SSE는 압축 대상에 포함하지 않는다.

## 검증과 남는 비용

- lint, format, typecheck, schema check, build 통과.
- 전체 unit/UI/architecture: 688개 통과. PostgreSQL 39개는 별도의 격리 integration에서 모두 통과.
- 격리 Compose E2E: import/replay, journal recovery, 재시작, backup/restore, 웹 smoke 통과.
  브라우저 page error 0개. Docker image build와 동시에 실행한 테스트의 시간 초과는 빌드 종료 후
  전체 suite를 다시 실행해 해소했다.
- 성능 게이트에 558행·9이닝 합성 원장의 실제 compiler 측정을 추가했다. 평균 5.766ms,
  p95 8.233ms로 평균 10ms·p95 25ms 기준을 충족했다.
- 실제 브라우저의 대시보드·DB·보정 목록에는 50ms 이상 long task가 없었다. 큰 경기의 최초 화면에는
  59ms 작업 1개가 남았고 이후 5개 행 선택에는 long task가 없었다.
- 캐시를 처음 채우는 비용은 남는다. 첫 원문 조회는 HTTP 표본에서 128~~352ms, 브라우저에서는
  447ms였고, 이력 상세의 첫 조회는 528~~598ms였다. 문서 자체의 full decode/hash도 유지한다.
  첫 문서 조회·session 생성은 이번 측정에서 빨라지지 않았다.
- 서버 교체 중 연결이 바뀌는 짧은 502 구간 뒤 `server_initializing` 503과 정상 200 전환을 확인했다.
  전체 2GB 검사에 약 136초가 필요하므로 재시작 직후 화면은 준비를 기다린다.

운영 자료에 correction commit이나 DB import를 수행하지 않았다. 시작 검증을 마친 뒤에도 이전
4,698개 current manifest의 SHA-256과 최종 manifest가 모두 같았다. API·웹·DB는 정상 상태다.

측정 원본은 git에서 제외된 `test-results/bottleneck-fixes-20260913/`에 보관했다. `audit.json`,
`startup.json`, `selection.json`, `future-paths.json`, `remaining-metrics.json`, `browser-final.json`과
각 품질 게이트 로그를 통해 재확인할 수 있다. 이전 측정은 `test-results/bottleneck-audit-20260913/`에
그대로 보존했다.
