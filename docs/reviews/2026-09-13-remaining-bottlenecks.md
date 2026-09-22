# 2026-09-13 최적화 적용 후 추가 병목 조사

앞선 최적화를 적용한 코드와 운영 API를 다시 확인했다. **재생 목록의 불필요한 전체 조회**는
작게 고칠 수 있는 현재 비용이고, **API 스레드의 동기 계산**은 수집·보정과 화면 조회가 겹칠 때의
응답성 문제다. 기록정정·분석·적재 이력에는 데이터가 쌓이면 커질 경로도 남아 있다.
이번 작업은 조사이며 제품 코드, 운영 데이터, 서버 실행 상태를 변경하지 않았다.

## 측정 조건

- 운영 API GET을 경로별 5회 실행했다. 시간은 localhost 요청부터 JSON 파싱 완료까지다.
- 현재 전체 목록은 4,698건이고 DB 적재 경기는 0건이다. 따라서 DB 성장 후 지연시간은
  이번 측정으로 확인할 수 없으며 아래에서 코드로 확인한 위험과 구분한다.
- Windows Node 24의 별도 프로세스에서 873-event, 682,126-byte 원장을 읽고 같은 로스터
  위치를 지정하는 보정 명령을 메모리에서 실행했다. 준비 3회, 측정 10회다.
- 수집·적재·보정 commit, 실제 제공자 호출, 재시작은 실행하지 않았다. 표본 current manifest도
  전후 동일했다. 측정 스크립트와 JSON은 무시되는 `test-results/bottleneck-followup-20260913/`에 있다.

## 1. 재생 화면이 수집 경기 전체를 내려받음 — 바로 개선할 항목

재생 controller는 공통 catalog를 요청한 다음 브라우저에서 DB 경기만 필터링한다.
DB 경기가 없는 지금도 수집 경기 4,698건을 받아 decode한다.

| 요청                               | 경기 수 | JSON 크기, 압축 해제 후 | 응답 중앙값 |
| ---------------------------------- | ------: | ----------------------: | ----------: |
| `/api/v2/games`                    |   4,698 |         1,293,640 bytes |     101.7ms |
| `/api/v2/games?authority=database` |       0 |                12 bytes |      14.8ms |

전체 목록에는 gzip이 적용되어 있다. 위 크기는 실제 압축 전송량이 아니다. 두 경로를 비교한
실측이며 아직 브라우저를 수정해 측정한 개선 결과는 아니다.

재생 전용 query key와 authority 필터를 사용하면 된다. DB도 커진 뒤에는 현재 달력·시즌 선택에
필요한 요약과 페이지를 조회하도록 확장할 수 있다.

근거: [재생 controller](../../apps/web/src/replay/use-replay-page-controller.ts)는 저장소 루트 기준
`apps/web/src/replay/use-replay-page-controller.ts:24`, 공통 호출은
`apps/web/src/api/collection-client.ts:46`이다.

## 2. 무거운 계산이 API 스레드를 점유함 — 동시 사용의 우선 과제

보정 명령은 서버에서 `applyCorrectionCommand`를 직접 실행한다. 수집의 source projection과
적재의 strict compile도 동기 계산이다. 서버 작업으로 예약하는 것만으로 이 계산이 HTTP 처리와
분리되지는 않는다.

최대 표본의 보정 계산 중앙값은 **106.0ms**, 같은 스레드에 예약한 타이머 실행까지는
**106.1ms**였다. 계산이 없는 대조군 타이머는 15.6ms였다. 이는 운영 API 동시 부하 시험이
아니며, 현재 구현의 동기 계산이 다른 콜백을 지연시키는 정도를 별도 프로세스에서 재현한 것이다.

동일 컴파일러를 제한된 worker에서 호출하는 방식이 후보이다. 명령 후 전체 strict compile,
session version 검사, 경기별 직렬화, 취소, 파일 commit과 DB 트랜잭션의 권위는 유지해야 한다.
검증을 생략하거나 수집 동시성만 올리면 해결되지 않는다.

근거: `apps/server/src/correction-session-manager.ts:151`,
`packages/correction/src/commands.ts:30`, `apps/server/src/source-projection.ts:28`,
`packages/persistence/src/revision-store.ts:178`.

## 3. 기록정정 목록에서 공지별 전체 제안을 계산함 — 조건부 병목

이전 수정으로 같은 경기의 저장 문서 읽기와 초기 compile은 한 요청 안에서 공유된다.
그러나 미처리 공지에 유효한 작업본과 binding이 있으면 공지마다
`buildRecordCorrectionBatchProposal`을 호출한다. 이 함수는 다시 전체 compile을 하며,
변경 명령이 있으면 `applyCorrectionCommand`의 compile·preview까지 수행한다.

공지별 상세 DB 조회도 남아 있다. 같은 경기의 공지가 많아질 때 목록 하나가 여러 차례
큰 계산을 수행하는 구조다. 현재 운영 DB가 비어 있어 해당 조건의 운영 지연은 측정하지 않았다.

같은 문서의 compile 결과를 명시적으로 공유하고, 검증한 공지 결과를 문서 hash·공지 내용·binding
기준으로 제한된 용량에서 재사용하는 방안을 검토한다. 목록 페이지에 필요한 공지만 평가하는 것도
후보이다. 검증하지 않은 작업본을 적재 가능 상태로 표시해서는 안 된다.

근거: `apps/server/src/record-correction-service.ts:213`,
`apps/server/src/record-correction-service.ts:299`,
`packages/correction/src/record-correction-proposal.ts:82`,
`packages/correction/src/record-correction-proposal.ts:345`.

## 4. 투수 분석은 캐시 확인 전에 표본을 다시 조회·계산함 — DB 성장 후 우선

`PitchAnalysisService`는 군집 결과를 재사용하지만 그 전에 항상 `samples.analyze`를 호출한다.
repository는 시즌 revision 목록 조회·source hash 계산·기준 파일 검증·해당 투수의 투구 조회와
궤적 계산을 반복한다. 따라서 같은 선수의 군집 수만 바꿔도 이 부분의 비용은 남는다.
기준 캐시가 없는 시즌은 시즌 전체 직구를 조회하고 기준 궤적도 API 스레드에서 계산한다.

시즌 source hash 확인은 유지하면서 표본 단계에도 용량 제한 캐시와 동시 요청 공유를 적용하고,
큰 궤적 계산을 worker로 옮기는 것이 후보이다. 운영 DB 적재 후 SQL 실행 계획과 최초·반복
조회 시간을 측정해야 한다. 선구안 분석에는 이미 worker, 요청 공유, known hash 재사용이 있어
그와 같은 중복이 있다고 일반화하지 않는다.

근거: `apps/server/src/pitch-analysis-service.ts:39`,
`packages/persistence/src/pitch-analysis-repository.ts:103`,
`packages/persistence/src/pitch-reference-workspace.ts:53`.

## 5. 적재 이력 증가에 따른 재시작·목록 비용 — 장기 누적 위험

적재 복구는 retained 기록, batch 기록, 개별 job 파일을 모두 읽는다. 각 디렉터리 안에서는
파일을 순차 읽고 hash/decode한다. 메모리 목록도 매 요청 전체 복사·정렬 후 필터링과 페이지
자르기를 수행한다. 경기 문서 startup 검증의 worker 최적화가 이 이력 경로까지 적용된 것은 아니다.

검증을 유지한 제한적 병렬 읽기, 복구에 필요한 활성 작업과 완료 요약의 분리, 정렬 인덱스가
후보이다. 완료 이력을 지우는 방식은 사용하지 않는다. 현재 운영 적재 데이터로 성능을 측정한
항목은 아니므로 앞의 두 항목보다 우선순위는 낮다.

근거: `apps/server/src/jobs/import-job-manager.ts:90`,
`apps/server/src/jobs/import-job-manager.ts:308`,
`packages/persistence/src/import-workspace.ts:104`.

## 함께 줄일 수 있는 작은 반복 작업

대시보드는 dashboard와 system/status를 각각 5초마다 조회하고 두 서버 경로가 모두
`buildSystemStatus`를 호출한다. 각 상태 검사에는 DB 쿼리 3개와 브라우저·workspace 점검이 있다.
대시보드와 DB 개요는 개수만 표시할 때도 DB catalog 전체 행을 읽는다.

이번 중앙값은 dashboard 40.2ms, system/status 14.7ms로 큰 병목은 아니었다. 동시에 들어온
상태 검사 공유와 집계용 DB 조회로 반복 비용을 줄일 수 있다. readiness의 최신 장애 감지는
유지해야 한다.

근거: `apps/web/src/pages/dashboard-page.tsx:21`, `apps/server/src/routes/system.ts:79`,
`apps/server/src/status.ts:32`, `apps/server/src/database.ts:31`.
