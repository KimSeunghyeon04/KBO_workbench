# 테스트와 성능 기준

추가 worker 회귀는 원본 endpoint/hash/canonical 검증, 보정 응답 격리와 준비 실패의 세션 불변,
V3/V4 projection hash 일치를 검사한다. PostgreSQL integration은 projection 생성·재조회 hash·
재projection 단계 실패의 전체 rollback과 페이지 경기 ID 조회를 확인한다. 이력 cache suite는
동시 쓰기·실패·재시작·응답 격리를, 상태 cache suite는 동시 요청 공유·절대 만료·실패 재시도를
검증한다. 실제 원본 성능 확인은 수집·commit 없이 임시 메모리 세션으로 수행한다.

`computation-pool` suite는 동일 compiler/명령 결과, 이벤트 루프 응답, 대기열 상한, 취소·오류 후
복구·종료, 시즌 행 분할 전송을 확인한다. 보정 suite는 계산 실패 시 undo와 version 보존을,
PostgreSQL integration은 worker 재compile 실패의 전체 rollback과 표본 캐시의 sourceHash 갱신,
동시 요청 공유·응답 격리를 검증한다. 재생 UI는 DB authority 요청을 사용한다.

추가 병목 회귀는 `bounded-read-cache`, `workspace-validation`, `collection-result-cache`,
`projection-batch`, `correction-session-lifecycle`, `startup-server` suite로 검증한다. 캐시 세대와
용량·만료·동시 읽기, worker의 동일 무결성 검사, 작업 사본의 stale version/미저장 보존/정리,
시작 중 503·종료 소켓, batch INSERT의 순서·parameter 상한을 검사한다. PostgreSQL integration은
SQL 목록의 페이지·시즌·문자열 검색과 기존 fact/hash/rollback 계약을 함께 검증한다.
`pnpm performance`는 기존 replay 측정에 더해 외부 호출 없는 558행·9이닝 합성 원장의 실제 compiler를
warm-up 20회 뒤 200회 측정하며 평균 10ms·p95 25ms 기준을 적용한다. 운영 자료의 HTTP 개선치는
같은 표본과 프록시에서 별도 측정하고 콜드/반복 요청을 구분한다.

목록 성능 회귀는 `tests/persistence/workspace-catalog.test.ts`와 staging workspace suite에서 검증한다.
10,000경기의 반복·동시 목록 조회가 추가 파일 읽기 없이 동작하는지, 바뀐 경기만 읽는지, 읽기 중
재변경·삭제·읽기 실패와 16개 동시 읽기 상한을 확인한다. 수집·quarantine/ready 전환·원천 실패·
교정 저장 후 오류·import 제거·재시작 뒤 표시가 갱신되는지 검사하며, 실제 문서 hash 검증은 유지한다.
실제 HTTP 성능은 같은 current 데이터와 localhost 웹 프록시에서 대시보드·적재 목록·검토 목록을 각각
3회 조회해 중앙값으로 비교한다. 조회 응답 개선과 시작 전 전체 무결성 검증 시간은 구분한다.

기간별 수집 회귀는 `tests/server/collection-operations.test.ts`, `collection-api.test.ts`,
`tests/web/collection-workspace-layout.test.ts`에서 검증한다. 비식별 일정 fixture 10,000경기의 월/일/연도
합계, 서버 페이지와 전체 선택, 부분 응답·원문 hash 실패, 작업본 보존, 중단 복구와 idempotency를
확인한다. 현황 경로는 전체 원장 조회가 호출되지 않는지 검사한다. UI는 탐색과 실행 범위의 분리,
페이지 간 제외, URL 우선 복원, 한국 날짜, 필터에서 제외된 상세 닫기를 검증한다.

격리 Compose E2E는 보존된 일정 fixture 602경기와 598경기 선택을 사용하고 일정 외부 호출을 하지 않는다.
백업/복원·재시작 후 수집 이력과 일정 조회를 확인하며, 브라우저에서 월→일→경기 탐색·키보드·페이지
제한·좁은 화면 상세 전환을 검사한다. 운영 경기 수집은 검증 단계에서 실행하지 않는다.

## 품질 명령

투구 움직임은 `tests/game-core/pitch-trajectory.test.ts`,
`apps/server/tests/pitch-analysis-api.test.ts`, `tests/web/pitch-analysis-page.test.ts`와 PostgreSQL
revision suite에서 검증한다. 평균 궤적 교차 시각·초기 접선 불변성·동시각 위치·시간차 부호·외삽,
시즌별 기준·current-only 읽기·제외 건수·응답 계약·시즌 및 구종 선택을 고정한다.
`pitch-clustering.test.ts`는 깊이에 의한 분리, 미배정, 순서·단위 불변성, 원표기와 독립인 계산을
검증한다. `pitch-plot-geometry.test.ts`는 회전과 실제 길이 비율, `workspace-navigation.test.ts`는
영역별 메뉴와 URL 복원을 검증한다. Compose UI smoke는 중계/군집 전환, 필터 복원, 실제 캔버스
변화, 드래그 회전과 모바일 메뉴 위치를 확인한다.

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm performance
pnpm schema:game:check
pnpm build
docker compose config
docker compose build
```

`test:integration`은 고유한 PostgreSQL 16 container와 network를 만들고 fresh V3 migration head,
revision 1→2 적재 transaction, typed 재조회·compile·projection hash, 과거 revision 불변, stale base,
seal/current pointer, catalog identity FK, tracking 단일 저장, registry snapshot/stint와 analyst 권한을
검증한다. 종료 시
자신이 만든 container와 network만 제거한다.

`test:e2e`는 고유 Compose project와 임시 port·data·volume을 사용한다. 실제 Naver network는 호출하지
않고 sanitized fixture로 수집 원장 저장, 보정, import, typed replay, backup/restore와 UI smoke를
검증한다.

## 필수 회귀 범위

2025 시즌 사례는 `tests/fixtures/naver/season-review-relay.anonymized.json`과 correction의
`fielder-choice-multistep`, `extra-inning-called-game`, `terminal-bunt-count` 비식별 fixture로 고정한다.
교체 역할·동명이인 후속 진루·포수 자동 볼·종료 반복/표시 보존, 책임 슬롯·연장 종료·번트 관찰을 검증한다.
import durability는 500건 초과 선택, 선택 뒤 변경/개별 제외, 중복 요청, 재시작, DB commit 후 정리 실패,
기록 장치 실패와 hash 변조를 다룬다. 웹은 10,000경기 페이지, 필터 상세 해제, 확정 선택 유지와 보정 후
정확한 문서 hash로 단건 적재를 확인한다. PostgreSQL suite는 위 fixture의 typed 재생·rollback·새 revision
적재와 이전 revision hash 보존을 함께 검증한다. 실제 Naver 요청은 사용하지 않는다.

투구 metadata 회귀는 저장 원문 비식별 사례, 문자열·숫자 구속과 빈/잘못된 값, 좌표·ID 누락,
수동 값 보존, 삭제·재정렬, hash 실패, 보정 왕복과 undo/redo, 일회 보완 재실행을 포함한다.
격리 DB는 V3 DDL과 V3 컬럼으로 봉인 기록을 만든 뒤 0004 migration을 적용해 과거 manifest/hash와
replay를 비교하고 V4 append, stale base, rollback, sealed 보호와 분석 view를 확인한다.
이어서 `0005_tracking_plate_height`를 적용해 V3/V4 봉인 manifest·측정값·projection hash·재생 불변을
검증한다. `tests/helpers/tracking-geometry.ts`의 동일 plate Y/상이한 높이, 선형·곡선 궤적, 존 경계,
누락·비정상·교차 불가 사례를 SQL과 재생에 함께 적용한다. 실제 적재한 투구에서 존 안/밖 스윙과
비스윙, 미제공 및 미지원 profile의 Zone/Chase 분자·분모를 검증한다.
`0006_tracking_zone_parallel_safety`까지 적용한 후 10,000개 궤적을 병렬 쿼리 활성화 설정에서 집계해
EXCEPTION subtransaction 오류 없이 정확한 존 안 투구 수를 반환하는지 검증한다.

### 수집 원장

- Naver 의미 행 하나가 평면 원장 행 하나로 보존됨
- 판독·공지·휴식·footer와 `unresolved`가 유실되지 않음
- 한 행 실패 뒤 후속 중계와 다음 반이닝이 끝까지 남음
- 누락 타석 시작·결과·주자 행을 합성하지 않음
- 의미 있는 재전송도 원천 위치별 원장 행으로 모두 보존함
- source 위치, 원문, 선수·판정·관측 상태가 strict round-trip에서 유지됨
- JSON 필드 순서, unknown/cosmetic 필드와 공백 정규화가 semantic 결과를 바꾸지 않음
- 같은 강도의 선수·결과 근거가 충돌하거나 동명이인을 좁힐 수 없으면 `unresolved`가 됨
- 반복 행의 결정적 identity와 finding code·원천 위치 evidence가 안정적임
- staging 재수집 제외가 한 번의 batch 진행으로 반영되고 외부 수집과 경기별 journal 쓰기를 하지 않음
- source endpoint payload와 manifest가 canonical gzip bundle로 불변 저장됨
- 한 투구의 완전 동일 tracking 재전송은 첫 관측 linked·나머지 duplicate이며 모든 source 위치가 보존됨
- 같은 `sourcePitchId`가 다른 PA·ordinal에서 서로 다른 실제 투구에 연결됨
- 동일 문맥 metric 충돌, 개수 불일치, orphan, pending과 다중 canonical link가 차단됨
- 같은 ID 반복과 PTS ordinal 차이는 warning이고 blocking이 아님

### Compiler와 야구 규칙

- 타석 결과가 타자 기본 상태만 파생하고 기존 주자는 실제 `runner_advance`만 반영함
- 연결 주자 행의 원자적 임시 상태 검증과 실패 시 부분 적용 없음
- dangling link, 잘못된 독립 사유, 사이에 상태 변경 행이 있는 연결을 차단함
- 주루사 3아웃 partial과 3아웃 미만 `source_half_incomplete`를 구분함
- completed/partial PA, 실제 투구 수와 다음 반이닝 event bridge가 정확함
- force/time play, appeal, apparent fourth out, 책임 투수와 교체 규칙이 유지됨
- 공식 기록 비교와 계산 기록이 결정적임
- movement engine 실패 뒤 입력 베이스·아웃·책임 주자 객체가 변경되지 않음

### 아키텍처

- package root의 `export *`와 package deep import가 없음
- `game-core`에 provider 이름·한국어 lexical 정규식·UI·DB adapter가 없음
- production collection 코드에 특정 경기 ID·fixture 위치 분기가 없음
- Fastify composition root와 route plugin, 보정 page와 controller/editor/component 경계가 유지됨
- emitted runtime import를 순회해 projection 재생·원장 복원에 compiler/DB adapter가 유입되지 않음
- current 전환·session store가 상위 workspace/manager를 역참조하지 않음
- 기록정정 jobs/sources/cases가 공개 repository를 역참조하지 않고 이벤트 입력 UI가 drawer를 역참조하지 않음
- DB correction draft 열기는 주입한 worker compiler를 한 번 호출하고 차단 문서를 quarantine에 저장함
- compiler 실패 시 correction draft의 current/original을 바꾸지 않음
- 계산 중인 clean session은 유휴 시간이 지나도 회수하지 않고 계산 종료 후 기존 유휴 정책을 적용함

### 보정과 UI

- 원장 행 추가·교체·삭제·이동이 각각 undo/redo 한 단위임
- 매 명령 뒤 전체 compiler finding으로 교체됨
- `unresolved` 변환 시 원문과 source identity가 유지됨
- 타석 결과와 주자 이동 편집기가 분리됨
- 선수 검색, 중계 문구, keyboard 접근성과 stale session 거부가 동작함
- 차단 draft는 quarantine에만 저장되고 DB import가 거부됨
- tracking link/duplicate/exclude/unlink와 중복 그룹 batch가 실제 pitch 1:tracking 0..1을 보장함
- 수집 SSE의 비변경 진행은 작업 목록만 갱신하고 catalog query 폭주를 만들지 않음
- 784개 DB·기록정정·작업 목록은 2,000 미만 DOM node를 유지하고, 선택 전 revision/공지 상세 요청은
  0회이며 선택한 항목 endpoint만 한 번 호출함
- 수집·기록정정·Database의 URL 직접 진입, 새로고침과 뒤로/앞으로가 검색·범위·선택을 복원함
- 운영 콘솔 목록 행에 finding 수나 반복 행동 버튼이 없고, 기록정정 처리 뒤 다음 미처리 항목과 남은
  수를 표시함
- 1280×720에서 목록·상세가 한 화면 작업영역에 있고 390×844에서는 목록→상세→뒤로로 전환하며
  가로 scroll과 상세 끝에 묻힌 주요 행동이 없음
- 수집·재생 catalog는 viewport와 overscan만 렌더링하고, 재생 listbox는 canonical filtered index와
  `aria-activedescendant`, `aria-setsize`, `aria-posinset`을 유지함
- production build는 route별 lazy chunk를 만들고 500KB 초과 chunk 경고가 없음

### PostgreSQL과 재생

- strict 원장 decode부터 새 revision seal/current 전환까지 한 transaction으로 처리됨
- 원장 fact와 최종 pitch·tracking·play·movement·PA·상태·선수 기록이 typed 컬럼에 저장됨
- DB 재조회 원장을 다시 compile한 결과가 저장 projection과 같음
- revision 1→2, 과거 revision 불변, stale base 거부와 transaction rollback이 보장됨
- 타석 결과와 연결 주자 행이 한 원자적 replay frame으로 표시됨
- replay와 분석이 staging JSON 복원 없이 typed fact만 사용함
- current/all-revision, 선수 시즌 집계, NULL denominator와 zone/chase query가 정확함
- catalog source identity FK와 canonical mapping 변경이 sealed projection hash를 바꾸지 않음
- tracking scalar가 원천 관측에 한 번만 저장되고 pitch link에 복제되지 않음
- registry 등록 공백을 넘는 stint가 없고 개명·등번호 event가 소속 stint를 바꾸지 않음
- V2 current revision 1→2가 V3 revision 1로 전환된 뒤 최신 원장과 replay 의미가 같음

## Python fixture 기준

기존 `KBO_scrapping_analysis/tests/v3`의 Naver runner·누락 타석·partial PA·교체·tracking·보정
fixture는 TypeScript 회귀 기준으로 포팅한다. Python 객체 형태를 유지하는 것이 아니라 같은 원천
사실이 평면 원장 행, compiler play, 최종 상태·기록과 finding으로 올바르게 변환되는지를 고정한다.

특히 다음 실경기 유형을 네트워크 없이 검증한다.

- 실책 뒤 동일 base 유지와 파울 플라이 포구 실책
- 대타 heading, 동명이인, 타석 중 대타와 DH 해제
- 병살 시도 1아웃, 병살 뒤 추가 태그 3아웃과 time play 득점
- 야수선택 뒤 prior-pitcher 책임 슬롯
- 원천 한 행 누락 뒤 후속 타자·반이닝 보존
- 반복 행 묶음과 직전 반이닝 결과 혼입
- 동일 `sourcePitchId`의 서로 다른 투구와 tracking 관측
- 기록정정 공지와 DB의 `대전`/`대전(신)` 표기 차이, 구장 미제공, 날짜·대진 불일치와 DH 구분
  (`record-correction-venue.anonymized.json`의 팀·선수·경기 ID는 비식별이며 구장 표기 차이를 보존)
- 미연결 공지의 해당 경기 최초 적재 후 재평가와 무관한 경기 적재 시 상태 유지
- 실제 자료를 비식별화한 누락 2루타·복수 투수·대주자 타순 fixture에서 KBO 제안 보완,
  명시된 값 충돌 보존, undo/redo·저장 대기, 투수별 자책점 분리와 참가자 역순,
  교체 타순 승계·수비 위치 변경·잘못된 공지 타순 거부를 검증한다.
- 제안 화면의 선수명·한국어 통계명·`미제공 → 값`과 KBO 보완 표시를 검증한다.

## Event windowing

보정 timeline은 고정 row 높이, viewport, scroll과 overscan으로 visible window만 렌더링한다. 필터와
무관한 canonical 원장 순서 이동은 DOM이 아니라 전체 event 배열을 기준으로 계산한다.

## Replay 성능

투구 기준 캐시는 `tests/persistence/pitch-reference-workspace.test.ts`에서 동시 요청·재시작·손상·잠금과
시즌 키 분리를 검증한다. PostgreSQL integration은 저장 기준과 매번 계산한 응답의 전체 동등성,
current revision 변경에 따른 재계산을 확인한다. Compose E2E는 2024·2025 기준을 만든 뒤 API를
재시작해 응답이 같고 기준 파일 hash와 수정 시각이 그대로인지 검증한다.

자동 구장 보정은 `tests/game-core/pitch-calibration.test.ts`에서 알려진 편향 복원, 미래/당일 제외,
입력 순서 불변성, 연결망·표본 부족과 식별 불가를 검증한다. persistence 회귀는 중간면 통일,
가속도 차감과 원천 보존, 과거 경기 정정 시 이후 창 무효화, 손상 캐시 복구를 확인한다.
worker의 5,000행 청크 전달과 직접 계산의 동일성, GMM의 보정 해시별 캐시 분리,
화면의 보정 구수·개별 차감량을 확인한다. Compose 재시작 검증은 일별 보정 파일도 포함한다.

2026-09-20 로컬 Node 24.19.0 검증에서 2020~2025년 각 시즌 6월 1일·8월 1일·9월 15일의
18개 창을 기존 Python 연구 모형과 대조했다. 90,951개 입력 셀에서 수평·수직 계수의 최대 차이는
`4.27e-12 ft/s²`였다. 비교는 두 모형 모두 지원 조건을 충족하는 창의 계수이며, 공분산의 PSD
처리와 표본 부족 시 운영 정책은 별도로 문서화한다.

같은 날 저장된 2025년 235,054구(779경기)를 실제 TS worker에 넣은 단회 측정은 다음과 같다.
DB 조회·HTTP·GMM은 제외했고, 타격 결과 필드는 시간 측정용 자리표시자를 사용했다.

| 작업                                           | 로컬 측정 |
| ---------------------------------------------- | --------: |
| 191개 날짜 계수 최초 생성과 파일 저장          |    7.77초 |
| 저장된 계수 읽기·검증                          |      33ms |
| 전체 행 재집계 후 같은 과거 입력의 계수 재사용 |    1.00초 |
| 보정된 시즌 포심 기준 생성                     |     456ms |
| 투수 3,380구 좌표 생성                         |      57ms |

14,341개 투수·경기·구종 셀에서 170개 날짜의 계수가 준비됐고 첫 지원일은 2025-04-05였다.
계수 JSON은 약 1.61MB였다. 이는 해당 수집 범위와 장비의 관측값이며 요청 지연 상한은 아니다.
기존 표본 메모리 캐시 적중 시에는 계수와 좌표 계산을 다시 수행하지 않는다.

```powershell
pnpm performance
```

production build 뒤 fixture를 warm-up하고 반복 측정한다. 기본 기준은 평균 10ms 이하, p95 25ms
이하다. 브라우저 재생 tick은 이미 받은 typed frame index만 바꾸며 API나 compiler를 다시 호출하지
않는다.

## 확장 분석의 학습·조회 검증

snapshot 자원 수명, worker 전송과 실행기 import 경계, 동일 범위 목록의 요청 병합·취소,
미채택 모델의 행렬 생성 생략은 별도 회귀로 고정한다. 계약의 sparse/symbol 배열 거부와
공용 HTTP reader의 스트리밍 바이트 상한도 검증한다.
[전체 모듈화 점검과 검증 기록](reviews/2026-09-22-modularity-refactor.md)을 참고한다.

A10/A11/A14는 시간 분할과 미래 전처리 누수, 게임 단위 불확실성, 미채택·미지원, 모델 파일
원자적 공개와 source manifest 무효화를 검증한다. RE24/카운트 RE는 atomic play 합계와
투구/비투구 연결 보존을, 승리확률은 동점과 연장 규정을 구분한다. 새 SQL은 기존 통합 suite의
격리 DB에 포함하고, 모델 패널은 Compose 데스크톱/모바일 E2E에서 연다.

`pnpm performance:analytics`는 별도 설정의 30회 계산/직렬화 benchmark만 실행한다.
Compose E2E는 작은 fixture 조회의 SQL/처리/직렬화와 실행계획을 기록한다.
[측정 결과와 적용 한계](analysis/performance.md)를 참고한다.

품질 요약 검증은 workspace 손상·writer 소유권, 준비 병합·대기 상한·실패/재시도/종료,
DB의 날짜 필터·재시작·revision/분류/신장 무효화를 포함한다. `analysis:audit --mode queries`는
최초 202 상태 응답과 준비 완료 시간을 따로 기록하고 새 route instance의 저장 요약 재사용을
확인한다. [측정 범위](analysis/2026-09-21-coverage-preparation.md)를 따른다.
