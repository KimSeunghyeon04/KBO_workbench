# 2026-09-13 화면 전환·목록 조회 성능 개선

수집 데이터가 늘어난 뒤 화면 전환과 목록 로딩이 느려지는 공통 원인은 workspace catalog 조회였다.
조회마다 4,698개 current manifest, finding sidecar, superseded 디렉터리를 다시 읽었다.
기존 웹의 페이지 처리와 가상 목록 앞에서 API 응답만 약 4~5초 걸리는 상태였다.

## 변경

- persistence 내부 `WorkspaceCatalog`에 시작 시 검증한 경기별 표시 요약을 보관한다.
- 일반 목록과 교정 목록은 같은 요약을 사용하며 반환 객체를 복제해 호출자의 변경을 격리한다.
- current 전환 시작과 완료·실패 시 해당 경기만 무효화한다. 새 조회는 진행 중인 저장을 기다린다.
- 여러 조회가 겹치면 갱신 작업을 공유하고 파일 읽기는 최대 16개로 제한한다.
- 읽기 중 새 저장이 발생하면 이전 결과나 이동된 artifact의 오류를 버리고 다시 읽는다.
- 유효한 최신 읽기의 실패는 오류로 반환한다. 오래된 표시를 정상 결과로 숨기지 않는다.
- 인덱스는 폐기 가능한 표시 정보다. 실제 문서 읽기, strict compile, hash, CAS, writer lock,
  journal recovery와 DB import의 권위 및 검증은 유지한다.
- API·문서·DB 계약과 웹 코드는 이번 성능 변경에서 수정하지 않았다.

## 운영 적용과 측정

2026-09-13 18:23 KST 개선 전 측정, 18:33 API 교체, 18:37 개선 후 측정을 수행했다.
적용 직전 활성 collection/import job은 각각 0개였다. DB와 웹은 유지하고 API만 교체했다.
배포된 `workspace-catalog.js`의 SHA-256이 호스트 빌드와 같은지 확인했다.

같은 4,698개 current 데이터에 대해 `http://localhost:8080` 웹 프록시로 각 요청을 3회 호출했다.
시간은 HTTP 요청 시작부터 응답 JSON 파싱 완료까지이며 브라우저 렌더링 시간은 포함하지 않는다.

| 요청                                                          | 개선 전 중앙값 | 개선 후 중앙값 |    배율 |
| ------------------------------------------------------------- | -------------: | -------------: | ------: |
| 대시보드 `/api/v2/dashboard`                                  |      4,894.3ms |         20.1ms | 243.5배 |
| 적재 목록 `/api/v2/database/games?authority=staging&limit=50` |      4,630.6ms |         39.0ms | 118.7배 |
| 검토 목록 `/api/v2/games?authority=quarantine`                |      4,271.2ms |         29.7ms | 143.8배 |

개선 후 세 요청의 첫 호출도 각각 66.8ms, 60.0ms, 48.2ms였다.
표시 건수는 준비 4,645경기, quarantine 49경기, source failure 4경기로 전후 동일하다.
대시보드 검토 필요 53건은 quarantine과 source failure의 합계다. DB 봉인 경기는 0건이므로
이 측정은 수집 작업본 목록에 대한 결과이며 대규모 DB 분석 성능을 의미하지 않는다.

4,698개 current manifest의 적용 전후 파일 SHA-256을 전수 비교했고 변경은 0개였다.
문서 hash와 content hash를 담은 current 포인터도 모두 동일하다. 경기 데이터 재수집·교정·적재는
실행하지 않았다. 적용 후 API·DB·웹 health와 웹 경유 readiness HTTP 200을 확인했다.

시작 전 전체 workspace 무결성 검증은 유지된다. 이번 재시작도 약 3분 39초 후 listen했으며,
위 수치는 서버 준비 이후의 조회 성능이다. 오프라인 파일 유지보수 후에는 API를 다시 시작해
표시 인덱스를 재구축한다.

## 검증

- 신규 회귀 8개 포함 전체 673개 테스트 통과. 기본 suite에서 skip한 DB 38개는 별도 격리
  PostgreSQL 16 통합 실행에서 모두 통과했다.
- 10,000개 요약의 반복·동시 조회, 변경 경기만 읽기, 최신 저장과의 경합, 삭제·오류·갱신 재시도,
  16개 동시 읽기 상한, 수집·교정·적재 제거·재시작 표시를 검증했다.
- typecheck, format:check, schema:game:check, build와 제품·테스트 소스 lint 통과.
- 전체 `pnpm lint`는 기존 Git 제외 `test-results` 실험 파일의 133개 오류로 실패했다.
  `eslint . --ignore-pattern 'test-results/**'`는 통과했다.
- `pnpm performance`: 500회 평균 0.944ms, p95 1.386ms로 기준 10ms/25ms 이내다.
- Docker API 이미지 빌드 및 실제 운영 데이터의 읽기 전용 HTTP 비교를 완료했다.
  별도 Compose E2E와 브라우저 렌더링 계측은 이번 변경에서 실행하지 않았다.

원시 측정, current hash 비교, 테스트 로그는 Git 제외 경로
`test-results/catalog-performance-20260913`에 있다. 재현 스크립트는 `measure-http.mjs`이며
`before.json`, `after.json`, `comparison.json`에 측정값과 데이터 동일성 결과를 저장했다.
