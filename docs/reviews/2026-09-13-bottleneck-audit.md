# 2026-09-13 추가 병목 조사

목록 인덱스 적용 이후 남은 병목을 조사했다. 우선순위는 **보정 세션 정리, 대량 적재 대상 확정,
서버 시작 검증**, 다음은 **수집 이력 상세와 보정 원문 조회의 반복 읽기**다.
제품 구현과 운영 데이터를 변경하지 않았으며, 아래 개선안은 아직 적용하지 않았다.

## 조사 범위와 측정 조건

- 운영 current 4,698건: ready 4,645, quarantine 49, source failure 4.
- 원장 4,694개 파일의 합계는 2,002,393,610 bytes, 약 2.00GB다.
- 파일 크기 순 중앙·95백분위·최대 원장 3개를 표본으로 사용했다. 경기 전체 모집단의
  지연시간 p95를 측정한 것은 아니다.
- 표본은 각각 540/668/873 events, 299/363/471 tracking candidates, 426/527/682kB다.
- 운영 API는 localhost 웹 프록시로 각 3회 측정했다. 원문 evidence는 서로 다른 행 3개를
  각 1회 측정했다. 시간은 HTTP 요청부터 JSON 파싱 완료까지다.
- CPU 비교는 Windows Node 24에서 1회 준비 실행 후 10회, 원본 비교는 20회 측정했다.
- Chromium은 기존 Playwright 런타임의 headless 모드로 로컬 웹만 탐색했다. 실제 Naver 요청,
  운영 수집·적재·교정 commit, 서버 재시작은 실행하지 않았다.
- 적재 선택과 메모리 실험은 별도 프로세스·격리 workspace/메모리 사본을 사용했다.
  운영 보정 세션은 읽기 및 `apply:false` 검증에만 사용하고 조사에서 만든 세션을 삭제했다.

## 1. 보정 세션의 수명 관리 — 우선

**코드에서 확인된 누적 구조 + 격리 메모리 실측.** 웹은 새 사본을 열 때 이전 React 상태를
교체하고 저장 성공 때 `setSession(null)`을 호출한다. 서버 DELETE 호출은 웹에 없고,
서버의 sessions Map에는 TTL·개수 제한·자동 회수가 없다. 페이지를 이동해도 이전 서버 사본과
그 undo/redo 원장이 남을 수 있다.

최대 표본으로 사본 30개를 열고 GC를 실행해도 heap이 **69.4MiB** 늘어난 상태로 유지됐다.
manager를 닫은 뒤 증가분은 **1.9MiB**였다. 반복 보정 뒤 메모리가 늘어나는 원인이 될 수 있다.
현재 운영 서버가 이미 이만큼 누적됐다는 뜻은 아니다.

개선: 저장 완료·사용자가 확정한 사본 폐기·사본 교체의 수명을 명시적으로 연결해
session version을 확인하는 DELETE를 호출한다. 비정상 종료로 남은 세션의 회수 정책도 정한다.
미저장 사본을 시간 만료만으로 조용히 폐기해서는 안 된다.

근거: [서버 Map](D:/Github/KBO_workbench/apps/server/src/correction-session-manager.ts:62),
[서버 삭제](D:/Github/KBO_workbench/apps/server/src/correction-session-manager.ts:286),
[웹 저장 완료 처리](D:/Github/KBO_workbench/apps/web/src/correction/use-correction-session-controller.ts:130).

## 2. 전체 적재 대상 확정 — 우선

**실측.** 운영 자료에서 분산 추출한 ready 32경기를 격리 workspace에 복사하고 실제
`ImportJobManager.createSelection`을 실행했다. 3회 2,613/2,428/2,175ms, 중앙값 **2.43초**였다.
매번 **문서 읽기 64회**가 발생했다. 선택 기록은 격리 workspace에만 저장했다.

`createSelection`은 HTTP handler 안에서 후보를 순차 처리한다. 각 `readDocument`가
`readCurrentFindings` 안에서 문서를 검증한 뒤 다시 `readCurrentDocument`를 호출한다.
대상 hash 작성도 추가 비용이다. 현재 4,645개를 모두 선택하는 경로는 수분 지연이 예상된다.
32개 측정치를 단순 비례하면 약 5.9분이지만, 전체 선택은 실행하지 않았으므로 확정값이 아니다.

개선: 한 번 검증한 문서·findings·hash를 같은 호출 안에서 공유하고 중복 읽기를 제거한다.
대량 선택 확정을 진행률과 취소가 있는 서버 작업으로 옮기는 방안도 필요하다. 동시 읽기는
제한하고 대상 hash 고정, 실제 import 직전 검증 및 stale 거부를 유지한다.

근거: [대상 확정](D:/Github/KBO_workbench/apps/server/src/jobs/import-job-manager.ts:158),
[문서 읽기](D:/Github/KBO_workbench/packages/persistence/src/staging-workspace.ts:478),
[findings 검증](D:/Github/KBO_workbench/packages/persistence/src/staging-workspace.ts:884).

## 3. 서버 시작 전 전체 검증 — 우선

**이전 적용 때의 운영 실측 + 현재 코드 확인.** 직전 API 재시작은 약 **3분 39초** 뒤 listen했다.
현재 원장만 약 2GB이며, startup이 current 문서 decode/hash 검증과 active 디렉터리 확인을
순차 수행한 뒤 HTTP 서버를 연다. 이 동안 gateway는 준비 상태를 받을 수 없어 502가 발생할 수 있다.
이번 조사에서는 운영 서버를 다시 시작하지 않았다.

개선: full validation을 유지하면서 제한된 I/O 병렬화와 CPU 작업 분리를 검토한다.
HTTP의 준비 중 상태와 진행률을 먼저 제공하고 일반 작업은 검증 완료까지 차단하면 재시작 시
불명확한 요청 실패도 줄일 수 있다. healthcheck 유예 시간만 늘리는 것은 검증 속도 개선이 아니다.

근거: [startup 전체 순회](D:/Github/KBO_workbench/packages/persistence/src/staging-workspace.ts:1186),
[listen 이전 runtime 생성](D:/Github/KBO_workbench/apps/server/src/main.ts:8),
[직전 운영 측정](D:/Github/KBO_workbench/docs/reviews/2026-09-13-catalog-performance.md).

## 4. 수집 이력 상세 페이지 — 다음

**운영 API 실측.** 결과 779/784/802/803건인 작업 4개의 상세 목록을 20건씩 요청했다.
첫 조사에서 최초 호출은 **1.41~1.49초**, 반복 호출 중앙값은 **0.53~0.63초**였다.
재측정 중앙값도 **0.535~0.547초**였다. 응답 자체는 약 14kB다.

페이지 20건을 정하기 전에 해당 작업의 모든 결과 파일을 읽고 hash/decode·필터·정렬한다.
이후 현재 상태를 붙이기 위해 전체 inventory도 구성한다. 페이지 크기만 줄여서는 해결되지 않는다.

개선: 작업별 결과 요약과 정렬 인덱스를 유지하고 결과 추가 때 해당 작업만 갱신한다.
선택 페이지에 필요한 current 상태만 결합한다. 원본 결과 파일과 원자 저장 경로는 유지한다.

근거: [상세 페이지](D:/Github/KBO_workbench/apps/server/src/collection-operations-service.ts:358),
[전체 결과 파일 읽기](D:/Github/KBO_workbench/packages/persistence/src/collection-workspace.ts:154).

## 5. 보정 행 선택의 원문 evidence 조회 — 다음

**API와 브라우저에서 재현.** 표본 3경기의 행별 evidence 조회는 **100~409ms**였고,
최대 경기에서 브라우저로 서로 다른 행 5개를 선택했을 때 각 요청이 **276~304ms** 걸렸다.
반환되는 것은 약 1~15kB지만 매번 모든 endpoint gzip을 순차로 읽고 압축을 풀어 canonical JSON과
endpoint hash, 전체 bundle hash를 검증한다. 선택 행에 필요한 endpoint만 쓰는 추출기는 그 뒤 실행된다.

개선: 처음 검증한 불변 source bundle을 제한된 용량과 명확한 수명으로 공유하고,
동일 bundle의 동시 읽기를 합친다. sourceBundleHash와 endpoint·block·row 인덱스를 사용해
표시할 근거를 찾아야 한다. 서버 원장·컴파일 결과의 권위를 브라우저 캐시로 옮기지 않는다.
화면의 사용이 끝난 이전 evidence 요청에 AbortSignal을 전달하는 것도 낭비를 줄인다.

근거: [세션 evidence](D:/Github/KBO_workbench/apps/server/src/correction-session-manager.ts:227),
[bundle 전체 검증](D:/Github/KBO_workbench/packages/persistence/src/staging-workspace.ts:333),
[행 선택 자동 조회](D:/Github/KBO_workbench/apps/web/src/pages/correct-page.tsx:242).

## 6. 보정 명령과 원본 비교 — 다음

**실측.** 내용을 바꾸지 않는 동일 로스터 위치 명령의 `apply:false` 응답 중앙값은
표본 순서대로 **145/171/237ms**였다. 문서 수정·저장은 일어나지 않았다.
로컬 `applyCorrectionCommand` 계산만은 **88/116/138ms**, compiler 한 번은 **12/20/19ms**였다.

명령마다 before, provisional, final 전체 compile을 수행하며, preview에서 두 문서를 다시 hash한다.
snapshot도 draft hash와 canonical serialize/parse/decode를 수행하고 문서 전체와 eventContexts를
반환한다. 응답 크기는 **0.68~1.08MB**다. 같은 API event loop에서 이 동기 계산을 수행한다.

개선: 같은 session version에서 이미 확정된 before compile/hash를 공유하고, tracking 문맥 보정이
입력을 실제로 바꾸지 않은 경우 중복 계산을 피할 수 있는지 검증한다. 명령 후 전체 strict compile,
atomic play, version 검사와 preview 의미는 유지한다. 긴 계산의 worker 이전도 후보지만,
먼저 중복 작업 제거 효과를 측정하는 편이 좋다.

프론트의 `compareWithOriginal`도 `useMemo` 밖에서 매 렌더마다 전체 원장을 canonical 비교한다.
비교 함수만 로컬 중앙값 **25~33ms**였다. 문서가 바뀌지 않은 행 선택·drawer 상태 변경 때는
재사용할 수 있다. 다만 Chromium에서 행 선택 5회 중 50ms 초과 long task는 관찰되지 않았고,
최대 사본 최초 표시에서만 52ms task 한 건을 관찰했다. 현재 UI 멈춤의 주원인이라고 단정하지 않는다.

근거: [명령 compile 경로](D:/Github/KBO_workbench/packages/correction/src/commands.ts:30),
[snapshot](D:/Github/KBO_workbench/apps/server/src/correction-session-manager.ts:345),
[매 렌더 원본 비교](D:/Github/KBO_workbench/apps/web/src/pages/correct-page.tsx:250),
[비교 함수](D:/Github/KBO_workbench/apps/web/src/correction/original-comparison.ts:28).

## DB 적재 후 커질 지점

운영 DB의 봉인 경기는 0건이다. 다음 항목은 코드·로컬 투영으로 확인했으며 실제 DB 지연은 미측정이다.

| 지점           | 확인한 반복 작업                                                                                                         | 개선 후보                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| DB fact 삽입   | 표본 경기당 3,949/4,812/6,225개 투영 행을 한 행씩 `await INSERT`                                                         | descriptor 순서와 같은 transaction 안에서 parameter 상한을 지키는 batch insert                    |
| Replay 첫 로딩 | manifest와 페이지마다 `loadCompiled`와 bundle 전체 재생성. 표본당 4/4/5회, 30개 table 조회가 120/120/150회 반복되는 구조 | 한 다운로드의 검증된 sealed snapshot 공유. 새 로딩의 DB hash 검증, cursor 결합과 메모리 상한 유지 |
| DB 목록 페이지 | SQL은 전체 경기·revision 집계를 반환하고 서버에서 검색·정렬·slice. staging만 요청해도 DB 전체 catalog 호출               | authority별 필요한 경로만 호출하고 DB filter/count/page를 SQL로 내리기                            |
| 기록정정 목록  | 해당 작업본이 있는 notice마다 상세 조회·문서 검증·전체 compile, 같은 경기 공지가 여러 개면 중복                          | 같은 current token의 평가를 요청 안에서 공유하고 목록 페이지 적용                                 |

Replay 호출 수는 실제 `ReplayService`에 메모리 store를 넣고 끝까지 페이지를 읽어 확인했다.
DB를 사용하지 않은 해당 실행도 약 400~523ms였지만, 준비 실행 없는 단회 수치라 성능 기준으로
사용하지 않는다. bundle만 따로 준비 후 측정한 중앙값은 58/71/105ms였다.

근거: [행별 INSERT](D:/Github/KBO_workbench/packages/persistence/src/projection-repository.ts:14),
[replay bundle 로딩](D:/Github/KBO_workbench/apps/server/src/replay-service.ts:78),
[DB 전체 catalog](D:/Github/KBO_workbench/packages/persistence/src/revision-catalog-repository.ts:6),
[서버 목록 페이지](D:/Github/KBO_workbench/apps/server/src/routes/catalog.ts:27),
[기록정정 진행 상태](D:/Github/KBO_workbench/apps/server/src/record-correction-service.ts:216).

## 우선순위를 낮춰도 되는 항목과 측정 보완

- 대시보드·DB 목록·보정 목록의 기본 Chromium 진입에서 50ms 초과 long task는 없었다.
  최대 원장도 873개 전체 행 대신 10개 행만 DOM에 표시해 가상 목록은 동작했다.
- 라우트별 lazy loading과 정적 asset의 immutable cache는 이미 적용됐다.
- 반면 gzip 요청에도 JSON과 정적 JS는 압축 없이 전송됐다. 보정 목록 1.01MB, 전체 catalog
  1.29MB라 압축과 서버 페이지를 검토할 수 있지만 localhost에서 현재 응답은 44/63ms였다.
  CPU·파일 반복 읽기보다 우선순위는 낮다.
- 분석 계산은 이미 worker·동시 요청 공유·일부 hash 기반 재사용을 사용한다. 데이터가 들어온 뒤
  SQL 실행 계획과 cold/warm 분석 시간을 측정해 추가 우선순위를 정해야 한다.
- `pnpm performance`는 21-event fixture의 **replay bundle 생성**을 반복한다. compiler와 실제
  경기 크기, 보정 명령, source evidence, 대량 선택, 동시 API 지연·세션 메모리는 측정하지 않는다.
  작은 fixture의 통과를 전체 성능 보장으로 해석하면 안 된다.

측정 보완은 비식별 보통/연장 경기 fixture, 수백·수천 건의 이력/선택, 반복 세션 생성·폐기,
보정 중 health/list 지연을 별도 성능 회귀로 추가하는 순서가 적절하다.

원시 결과와 재현 스크립트는 Git 제외 `test-results/bottleneck-audit-20260913`에 있다.
`audit.json`, `selection.json`, `client-memory.json`, `browser-final.json`, `future-paths.json`을
참조한다. 조사 중 current manifest 전수 hash 비교는 동일했으며 최종 서비스 health도 정상이다.
제품 코드 변경이 없어 전체 unit/integration 품질 게이트를 다시 실행하지 않았다.
