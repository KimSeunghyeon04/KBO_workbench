# 2026-09-13 추가 병목 개선

[추가 조사](2026-09-13-deeper-bottleneck-audit.md)의 다섯 경로를 수정했다. 원장과 공개 응답 계약,
전체 compiler 및 DB 무결성 검증은 유지하고 계산 실행 위치와 표시용 조회를 개선했다.

## 구현

1. 원문 최초 읽기·압축 해제·endpoint canonical/hash·전체 bundle hash 검증을 공용 CPU worker로
   옮겼다. 같은 persistence reader를 인라인 및 worker 경로에서 호출한다. 캐시 용량도 worker에서
   계산하여 API가 원본 전체를 다시 직렬화하지 않는다. 원본은 worker 두 개에 각각 16MiB/4건,
   idle 5분 동안 보관하고 선택한 행의 근거만 반환한다. cache key는 경로·season·game·원본 hash에
   결합하며 같은 worker의 동시 읽기를 공유한다. 과부하 응답 503을 원문 route에 선언했다.
2. 보정 compile/command의 worker 메시지에 응답용 snapshot 준비를 함께 포함했다. 문서 hash,
   strict 사본, findings, event context는 worker에서 준비하고 세션은 완성된 결과를 받은 뒤에만
   변경한다. 준비 실패는 version·원장·undo/redo를 바꾸지 않는다. 미리보기는 기존 snapshot을
   재사용한다. commit은 검증된 내용과 저장 findings의 관계를 유지하며 metadata를 갱신한다.
3. DB projection 생성, 재조회 fact의 정규화·hash와 내부 재compile 뒤 projection 생성도 worker로
   분리했다. column set은 행마다 다시 만들지 않고 table별로 준비한다. 모든 행의 scalar 검증,
   V3/V4 hash 규칙, DB transaction·재조회·재compile·seal은 동일하다.
4. 분석 chunk를 합칠 때 worker 소유 배열에 각 행을 순서대로 추가한다. 이전 chunk 전체를 매번
   복사하는 누적 비용을 제거했다. 5,000행 전송 단위와 계산·취소·대기열 상한은 유지한다.
5. 대시보드·DB 상태의 숫자 집계는 DB 경기 ID만 읽는다. 화면 상태 검사는 500ms 절대 만료로
   공유하고 readiness는 매번 새로 확인한다. 수집 이력은 검증한 정렬 결과를 32MiB/20,000건까지
   재사용하고 페이지 사본만 반환한다. writer의 성공·동시 쓰기·실패에 맞춰 갱신/무효화하며,
   한도를 넘으면 파일 검증 경로를 사용한다. 이력 상세는 해당 페이지의 경기 ID로 workspace와
   DB catalog를 읽는다.

## 검증

- 전체 단위·UI suite: 699개 통과. PostgreSQL용 44개는 별도 격리 환경에서 실행했다.
- PostgreSQL integration: 44개 통과. projection 생성·재조회 hash·재projection의 실패별 전체
  rollback, worker import 성공, V3/V4 봉인·hash 유지, ID로 제한한 DB 조회를 포함한다.
- 격리 Compose E2E: restart, journal recovery, import/replay, backup/restore와 브라우저 흐름 통과.
  보정·수집·DB·기록정정 페이지 오류 0건. 분석 기준 파일은 API 재시작 뒤 그대로 재사용됐다.
- worker 회귀는 원본 hash·canonical 변조 거부, 사본 격리, 계산 오류 후 재사용, 대기열·취소,
  chunk 전체 행 보존을 검사한다. 이력은 동시 쓰기·실패·재시작·응답 격리, 상태 조회는 절대 만료와
  실패 재시도를 검증했다.
- lint, format:check, typecheck, schema:game:check, build 통과.
- `pnpm performance`: 558-event compiler 평균 6.857ms, p95 10.307ms로 10/25ms 기준 통과.

## 격리 측정

Windows Node 24에서 다른 테스트와 이미지 빌드가 끝난 뒤 측정했다. 큰 원장은 873 events이며
projection은 6,225행이다. projection은 준비 실행 뒤 7회 측정한 중앙값이다. 이벤트 루프
지연은 실행 중 1ms 간격 타이머에서 관찰한 최대 간격의 중앙값이며 운영 HTTP 지연과는 다르다.

| 작업            | 인라인 완료 시간 | worker 완료 시간 | 이벤트 루프 최대 지연, 인라인 → worker |
| --------------- | ---------------: | ---------------: | -------------------------------------: |
| projection 생성 |          148.4ms |          171.1ms |                         148.4 → 16.5ms |

worker 완료 시간에는 데이터 전송 비용이 들어간다. 이 변경은 다른 요청을 처리할 여유를 만드는
것이며 개별 계산의 완료 시간이 모두 줄었다는 의미는 아니다. DB SQL·transaction의 전체 완료
시간은 위 projection 수치에 포함하지 않는다.

원문 최종 경로는 매회 새 worker를 준비한 뒤 최초 근거 조회를 7회 측정했다. worker 준비 시간을
제외한 완료 중앙값은 290.0ms, 이벤트 루프 최대 간격의 중앙값은 16.6ms였다. 같은 worker의 반복
근거 조회는 0.35ms였다. 원본 검증과 cache 크기 계산은 worker에서 끝내며 API로 넘기는 근거는
3,272 bytes다. 수집 원본 전체를 API 스레드로 다시 복사하지 않는다.

미리 계산한 유효 결과를 공급해 보정 응답 준비만 분리한 측정에서는 API 스레드의 처리 시간이
**68.7 → 7.0ms**였다. 현재 보정 응답은 여전히 전체 세션 계약을 사용하므로 최대 표본의 압축 전
JSON은 약 1.08MB다. 전체 명령 완료 시간과 이 수치를 혼동하면 안 된다.

격리된 수집 이력 파일 1,000개에서 50건 페이지를 읽는 시간은 검증 캐시가 없는 **76.7ms**에서
캐시가 있는 **0.25ms**로 줄었다. 두 경로의 결과를 비교했다. 운영 이력을 합성으로 늘린 것은 아니다.

측정 스크립트와 원시 JSON, 품질 검사 로그는 무시되는 `test-results/deeper-fixes-20260913/`에 있다.

## 실행 서버 적용

전체 검증 뒤 진행 중인 작업과 열린 작업 사본이 없는 상태에서 최종 API·웹 이미지를 적용했다.
시작 무결성 검사와 worker 준비가 약 143.1초 뒤 끝났으며 현재 manifest 4,698개는 전후 hash가
모두 동일했다. DB volume이나 수집 원장을 교체하지 않았다.

같은 873-event 경기에서 각 5회 HTTP 요청을 측정했다. 보정 명령은 임시 메모리 세션에 같은
로스터 위치를 지정하는 no-op이고, commit 없이 삭제했다. 최종 원문 cache는 세션을 닫아도
유지되므로 각 측정 전에 다른 원본 네 개를 순차 조회해 해당 worker의 4건 cache에서 대상 원본을
밀어냈다. 이전 버전은 마지막 세션 삭제 때 원문 cache를 비웠다. 다른 부하 검사는 함께 실행하지 않았다.

| 실제 HTTP 측정                                    | 변경 전 | 최종 적용 후 |
| ------------------------------------------------- | ------: | -----------: |
| 원문 첫 조회 중 다른 상태 조회의 최대 지연 중앙값 | 152.9ms |       21.0ms |
| 보정 반영 중 다른 상태 조회의 최대 지연 중앙값    | 122.9ms |       61.9ms |
| 원문 첫 조회 완료                                 | 408.7ms |      425.8ms |
| 보정 반영 완료                                    | 301.3ms |      279.1ms |

첫 원문 검증은 약 0.43초가 필요하다. 위 개선은 특히 검증 중 다른 화면 요청이 기다리는 시간을
줄인다. 전송·복사 비용이 있으므로 계산 분리와 개별 요청 완료 시간의 효과를 구분한다.
실제 DB가 비어 있어 대량 DB 적재의 HTTP 동시 부하는 격리 projection 측정으로 대신했다.

실행 서버의 Chromium에서도 대시보드·DB·보정·재생 및 큰 사본의 행 선택을 확인했다.
브라우저 오류는 없었으며 clean 세션은 이탈 후 DELETE와 404로 정리됨을 확인했다.
