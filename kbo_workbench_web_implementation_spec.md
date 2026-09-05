# KBO Workbench Web V2 구현 명세

## 1. 목적과 권위

KBO Workbench는 Naver KBO 문자중계를 원본 증거로 보존하고, 사람이 교정 가능한 원장으로
정규화한 뒤, 단일 결정론적 compiler가 계산한 사실을 PostgreSQL에 봉인하는 로컬 도구다.

```text
Naver 원본 응답
  -> immutable source bundle
  -> StagingGameDocumentV2
  -> tracking·원장 교정
  -> game-core 전체 compile
  -> sealed PostgreSQL revision
  -> pitch·PA·play·runner·player-game SQL 분석 / replay
```

- 원본 응답은 관찰된 증거다.
- V2 원장은 현재 교정 대상이며 최종 경기 상태를 저장하지 않는다.
- `game-core`만 BSO·주자·점수·PA·통계를 계산한다.
- sealed DB revision은 불변의 분석·재생 권위다.
- `game_id`와 `revision`은 출처와 무결성 키다. 분석 grain은 pitch, PA, play, runner movement,
  player-game이다.

## 2. 기술과 모듈 경계

- TypeScript strict mode, Node.js 24, Fastify, React, Vite
- TypeBox strict runtime schema와 canonical JSON
- PostgreSQL 16, `pg`, SQL migration
- Vitest, fast-check, Testing Library, Playwright, Docker Compose

패키지는 `contracts -> game-core -> collection/correction/persistence/replay -> server/web`의 공개
API 방향을 지킨다. collection과 correction은 PostgreSQL을 직접 알지 않으며, game-core는
파일·DB·HTTP·React에 의존하지 않는다. 장기 수집과 적재는 server-side job으로 실행한다.

## 3. StagingGameDocumentV2

외부 파일 계약은 호환 분기가 없는 `StagingGameDocumentV2`, `schemaVersion: 2`다.

- `source`: provider, sourceGameId, collectedAt, sourceBundleHash
- `revisionBase`: `new_game` 또는 sealed revision 번호와 document hash
- metadata, teams, rosters, officialRecords
- 원천 순서의 평면 typed `events[]`
- 원천 tracking 관측과 교정 결과인 `trackingCandidates[]`

event kind는 `half_inning_start`, `batter_start`, `pitch`, `plate_result`, `runner_advance`,
`substitution`, `review`, `administrative`, `unresolved`다. 원장에는 계산 balls, strikes, outs,
base, score, PA, 선수 통계, DB play를 저장하지 않는다.

각 source event identity는 endpoint, blockIndex, eventIndex와 선택적 sourceEventId를 보존한다.
수동 행은 UUIDv7과 relayText를 갖는다. `sequence`는 배열 index와 일치하며 replacement는 identity,
source 위치와 sequence를 유지한다.

## 4. Source bundle과 collection

수집한 endpoint payload는 canonical JSON 후 gzip으로 `.data/source/<season>/<gameId>/`에 불변
저장한다. manifest에는 endpoint, 응답 hash와 최초 수집 시각을 기록한다. 같은 source bundle hash로
현재 DB revision을 재수집하면 새 draft나 revision을 만들지 않는다. hash가 바뀌면 current revision을
base로 하는 기록정정 draft를 만든다.

모든 의미 있는 relay 행은 typed event, review/administrative 또는 `unresolved` 중 하나로 보존한다.
알 수 없는 행을 버리거나 누락된 타석 시작·투구·결과·주자 이동을 만들지 않는다. provider 별칭,
한국어 문장과 정규식은 collection에만 둔다.

## 5. Tracking candidate

tracking candidate는 다음 typed 정보를 가진다.

- 결정론적 `trackingId`, endpoint/block/row source 위치
- 선택적이고 non-unique인 `sourcePitchId`
- nullable Naver `ballcount` 원천값인 `sourcePitchOrdinal` — PTS 관측 순번일 수 있으며 실제 PA
  투구 순번이 아님
- inning, half, PA, 선택적 투수·타자, stance
- `x0/y0/z0`, `vx0/vy0/vz0`, `ax/ay/az`
- `crossPlateX/crossPlateY`, `topSz/bottomSz`
- `pending`, `linked(pitchEventId)`, `duplicateOf(trackingId)`, `excluded(reason)` resolution

수집 매칭은 같은 endpoint/block와 non-unique sourcePitchId 안에서 원천 occurrence 순서를 사용한다.
투구 N개와 tracking N개는 같은 순서로 1:1 연결하며 Naver ballcount는 연결에 사용하지 않는다. 한
투구에 완전히 같은 tracking이 여러 번 오면 첫 source 위치를 canonical로 연결하고 나머지는
`duplicate`로 자동 분류한다. metric 충돌, 투구·tracking 개수 불일치와 대응 투구 부재만 pending과
blocking으로 남긴다. 실제 PA와 투구 순번은 compiler의 pitch fact만 계산한다.

같은 `sourcePitchId`가 경기 안에서 반복되면 `source.pitch_id.reused_within_game` warning과 모든 원천
위치를 각 관련 투구에 표시한다. ID 반복만으로 병합하거나 차단하지 않는다. provider ballcount와 실제
투구 순번 차이는 `source.tracking.ordinal_differs_from_actual_pitch` warning이며 분석에는 compiler
순번을 사용한다. PA·선수·이닝 문맥 불일치, 비실제 투구 link와 실제 pitch 한 건의 다중 canonical
tracking은 blocking이다. 실제 pitch의 tracking 누락은 warning이며 자동 판정과 `no_pitch`는 제외한다.

교정 command는 `link_tracking_candidate`, `mark_tracking_duplicate`,
`exclude_tracking_candidate`, `unlink_tracking_candidate`,
`reconcile_tracking_plate_appearance_contexts`다. 중복 그룹은 `correction_batch` 한 건으로
원자 적용한다. pitch 삭제 또는 비투구 교체는 candidate와 종속 duplicate를 삭제하지 않고
`excluded/manual_other`로 바꾸며 undo가 원래 연결을 복원한다. 별도 tracking 후보 패널은 두지 않고
선택한 투구 상세에 관측값을 표시하며 pending/conflict가 있을 때만 조작을 노출한다.

원장 편집 전후에 동일한 실제 투구 link가 유지되고 기존 candidate PA가 편집 전 compiler PA와
일치했다면 candidate와 동일 duplicate의 PA 문맥을 편집 후 compiler PA로 갱신한다. 삭제된 PA ID를
가진 기존 작업본만 명시적 reconcile 명령으로 복구하며, 존재하는 다른 PA와의 불일치는 자동으로
덮어쓰지 않는다.

## 6. 평면 원장과 compiler

pitch payload의 선택 필드 `speedKph`는 유한 양수, `pitchType`은 제공 구종 명칭이다. Naver
`textOptions[].speed/stuff`에서 해당 투구에 직접 귀속하고 tracking/ID 누락과 독립적으로 보존한다.
compiler는 metadata를 pitch fact로 전달하며 기존 경기 계산 규칙을 바꾸지 않는다. 보정 입력의
왕복·삭제·undo/redo와 DB typed replay relay event의 선택 `pitch` 속성까지 같은 계약을 사용한다.
값 없는 과거 replay에는 새 속성을 생략한다. 기존 current만 일회 보완하는 CLI와 검증·운영 절차는
[구속·구종 보완](docs/pitch-metadata-enrichment.md)에 정의한다. 웹 보완 기능과 스케줄러는 없다.

`plate_result`에는 타석 결과와 타자에게 직접 귀속되는 정보만 둔다. 기존 주자의 진루·아웃·득점은
별도 `runner_advance`다. 타석 play의 movement는 `plateResultEventId`를 참조하고 독립 movement는
명시적 reason을 가진다.

`compileStagingGameDocumentV2`는 strict decode 뒤 다음을 전체 계산한다.

1. event, roster, 참조, PA와 tracking resolution 검증
2. plate result·연결 movement·review/administrative를 atomic play로 구성
3. candidate state에서 movement 전체를 검증한 뒤 한 번에 commit
4. completed/partial PA, pitch fact와 PA 내 실제 투구 ordinal 계산
5. batter, pitcher, baserunner game line 계산
6. 공식 기록과 신뢰 가능한 observed state 비교
7. source/domain/persistence finding을 결정론적으로 정렬

제3아웃, walk-off, called game, partial PA, 책임 투수·대타, force/time/appeal 득점 규칙을 보존한다.
이벤트는 복제 state에서 검증하고 새 blocking finding이 없을 때만 반영한다. 같은 normalized 문서는
시간·플랫폼·실행 순서와 무관하게 같은 finding, projection, hash와 replay frame을 만든다.

## 7. 파일 workspace와 correction

```text
.data/
  source/<season>/<gameId>/
  original/<season>/<gameId>.json
  current/<gameId>.json
  active/<gameId>/<generation>-<contentHash>.document.json
  active/<gameId>/<generation>-<contentHash>.failure.json
  superseded/<gameId>/
  journals/
  exports/
  logs/
```

source와 original은 불변이다. versioned current manifest가 ready, quarantine, source_failure 중 하나의
active artifact를 정확히 하나 가리킨다. 교체된 generation은 content hash와 함께 superseded에 보존한다.
current manifest V2에서 ready/quarantine은 strict 원장에서 만든 경기일과 원정·홈 팀 ID/이름의
`displaySummary`를 필수로 가지며 source_failure는 관찰되지 않은 값을 만들지 않고 null을 가진다.
전환은 writer lock 아래 target fsync, transition journal, manifest atomic replace/directory sync, 이전
artifact 이동, journal 제거 순서를 사용한다. startup은 journal을 roll-forward하고 journal 없는 dual
active나 hash 불일치는 persistence-blocked로 중단한다. finding은 producer/lifecycle이 있는
`StoredFindingEnvelopeV2`로 저장하며 비면 sidecar를 두지 않는다. legacy 배치는 검증된 DB/workspace 쌍
backup과 명시적 migration 없이는 current로 해석하지 않는다. V1 current manifest도 자동 보완하지
않으며 기존 `workspace:migrate` dry-run/apply와 manifest upgrade journal로만 V2가 된다.

correction은 structured command만 허용한다. 매 command/batch 뒤 resequence하고 전체 compile한다.
세션별 async mutex 안에서 session version과 base document hash를 검사해 stale이면 거부하며, browser는
서버 응답 뒤 상태를 갱신한다. superseded snapshot 복구도 session 생성 시점 current content hash를
확인한 뒤 동일 상태 머신으로 commit한다.
기록정정 검토함에서 연 session은 보정 화면에 KBO 공지 원문과 전후 공식 기록을 함께 표시한다.
이닝·타석 접기 또는 펼치기는 해당 그룹 시작 행을 선택한 뒤 가상 목록을 갱신한다.
기록정정 공식 기록 비교는 field descriptor가 정한 생략 의미를 사용한다. 비발생 선택 계수는 0,
coverage 부재 가능 필드는 미제공으로 유지하며 원천 원장과 projection hash는 변경하지 않는다.
통계 지원 여부는 scope와 stat code 조합으로 판정하고, 투수 피희생플라이처럼 현재 집계하지 않는
항목은 원문 증거로만 보존한다. 적용·검증 가능한 변경이 전혀 없는 공지는 `지원 범위 외`로 분류해
수동 검토 알림에서 제외한다.
blocking draft는 quarantine에만 commit할 수 있다. sealed revision은 직접 수정하지 않고 correction
draft로 reopen한 뒤 새 revision으로 적재한다.

`lifecycle=while_event_unresolved` finding은 대응 행이 현재도 `unresolved`일 때만 현재 차단으로 병합한다. 사람이
typed 행으로 교체하거나 명시적으로 삭제한 행의 finding은 immutable original의 저장 당시 기록에는
남지만 현재 작업본의 차단으로 승계하지 않는다.

## 8. PostgreSQL V3

활성 DB는 PostgreSQL 16에 `database/v3/0001_v3_initial.sql`을 적용하고 migration head
`database/v3/0004_pitch_metadata.sql`까지 올린다.
analytics/projection/registry/record correction contract는 `4/4/1/2`이다. V2 SQL은
`database/migrations`에 복구용 legacy로
보존하며 V2 DB에 V3 DDL을 적용하지 않는다. JSON, JSONB, ARRAY와 tracking EAV 컬럼은 사용하지 않는다.

`catalog`에는 경기와 독립된 competition/season/team/player/venue entity, provider identity, 당시 이름
관측과 tracking measurement profile을 둔다. provider identity는 `naver:<id>`, `kbo:<id>`이고 KBO 공식
ID가 확인되면 canonical player는 `kbo:<playerId>`다. sealed fact는 변경 가능한 canonical ID가 아니라
불변 source identity를 참조하므로 이후 identity 연결은 과거 projection hash를 바꾸지 않는다.

`workbench`에는 game/current pointer, append-only revision과 parent, 경기 당시 team/roster/position
snapshot, typed ledger, official line, validation issue/detail, tracking 원천 관측과 manifest를 둔다.
`baseball`에는 play/event/movement, PA/event, pitch/link, final state, player-game fact를 둔다. tracking
측정값은 `tracking_observations`에 한 번만 저장하고 `pitch_tracking_links`는 key만 저장한다.
projection descriptor는 SQL column 순서와 runtime decoder를 함께 소유한다. DB 재조회 행의 shape,
nullability, enum, 정수, row count, game/revision 문맥과 key uniqueness를 검증하지 못하면
`PersistenceIntegrityError`로 transaction/replay를 중단한다.

`registry`에는 collection run, immutable season revision/current pointer, source page artifact provenance,
일별 등록 snapshot, 이동 event, resolution issue, first-team registration과 organization affiliation stint를
둔다. 등록 snapshot 공백을 가로질러 stint를 추론하지 않으며 개명·등번호 변경은 소속 stint를 바꾸지
않는다. 모호한 선수는 병합하지 않고 issue로 남겨 stint에서 제외한다.

`record_correction`에는 수집 run과 시즌 source revision/current pointer, 원문 page provenance,
notice/participant/stat change, 현재 match assessment와 candidate, append-only review action을 둔다.
source bundle 전체를 취득·파싱한 경우에만 revision을 seal하고 같은 bundle hash는 `no_change` run만
남긴다. 공지 내용 hash가 바뀌면 기존 해결·무시 결정을 수동 검토로 되돌리되 과거 action은 보존한다.

신규 경기 revision은 1이고 교정 import는 current+1이다. import는 strict decode/compile, source identity와
이름 관측 upsert, projection write/read hash, V2 ledger hydration/recompile, seal, current pointer 전환을 한
transaction에서 수행한다. 실패하면 전부 rollback하며 sealed revision과 fact는 불변 trigger로 보호한다.
V2 current-only 전환은 원래 revision/hash manifest를 남기고 `revisionBase`만 `new_game`으로 바꿔 V3
revision 1로 적재한 뒤 source, ledger, compiler와 replay 의미 hash를 모두 비교한다.

## 9. 분석 view와 지표

current view는 `current_pitches`, `current_plate_appearances`, `current_batted_balls`, `current_plays`,
`current_runner_movements`, `current_player_game_*`, `current_player_season_*`를 제공한다.
`all_revision_*`는 기록정정 전후 비교용이다.

투구 view는 실제/비실제, PA·선수·count·out·base·score 문맥, call과 strike/swing/whiff/CSW/in-play,
wide tracking을 함께 제공한다. raw player/team ID와 source identity, 현재 canonical ID를 함께 노출한다.
season view는 비율과 함께 numerator·denominator를 노출한다. denominator가 0이거나 measurement
profile이 zone을 지원하지 않거나 필요한 위치가 없으면 값은 `NULL`이다.

strike zone formula version 1은 공 중심 기준 다음과 같다.

```text
abs(cross_plate_x) <= 0.82917 ft
and cross_plate_y between bottom_sz and top_sz
```

공식 ER처럼 compiler가 독립 계산하지 못한 값은 `official_*` 이름으로 구분한다. 2024 규모에는
partition을 사용하지 않고 season/date/player/pitcher/batter/count/result 중심 index를 둔다.

## 10. API, Web, SQL 접속과 replay

모든 endpoint는 `/api/v2` strict DTO를 사용하고 system/catalog/collection/correction/import/revision/
replay route 경계를 유지한다. Database 화면은 revision history와 current를 표시하고 reopen과 명시적
재수집을 제공한다. correction 화면은 candidate source 위치·ID·PA·ordinal·metric 차이와 연결 가능한
pitch를 나란히 보여준다. Replay는 current/과거 revision을 선택하며 pitch마다 최대 한 tracking만
표시한다.

`GET /api/v2/games`의 catalog item은 authority 기반 strict union이다. ready/quarantine workspace와
database 항목은 경기일·대진을 제공하고 source failure는 관찰되지 않은 요약을 만들지 않는다.
workspace 항목은 파일 상태를,
database 항목은 relational fact에서 집계한 `gameDate`, `teams`, `currentRevision`, `revisionCount`를
필수로 가진다. Database는 이 요약만으로 목록을 그리고 선택한 경기의 revision 상세만 한 번 조회한다.
route page는 lazy chunk로 로드하며 수집·기록정정·Database는 공통 운영 콘솔 shell과 선택 가능한 고정
높이 virtual list를 사용한다. 상단에는 상태와 핵심 명령, 왼쪽에는 검색·범위 목록, 오른쪽에는 선택
상세와 sticky action bar를 둔다. 900px 이하에서는 DOM의 목록 상태와 scroll을 유지한 채 목록과
상세 중 하나만 표시한다. 검색어 변경은 URL history를 replace하고 범위·항목 선택은 history entry를
추가한다. 기록정정 목록은 경량 DTO를 사용하고 원문·후보·통계 변경은 단건 endpoint에서만 읽는다.

PostgreSQL은 `127.0.0.1:${KBO_DB_PORT:-5433}`에만 공개한다. 별도 analyst 계정은 `analytics` schema
SELECT 권한만 가지며 기본 transaction이 read-only다. DBeaver, Jupyter, R 등은 직접 접속할 수 있지만
Jupyter service는 Compose에 포함하지 않는다. 예제 쿼리는 `database/examples/`에 둔다.

공개 replay는 DB typed fact에서 atomic play frame을 직접 만든다. staging JSON을 복원하거나 browser
compiler를 실행하지 않는다. cursor는 game, revision, document hash, frame hash와 결합하며 최대 page
limit은 1000이다.

기록정정 API는 job 생성·조회·취소, 상태 summary/list/detail, append-only review action, correction
draft 생성, session proposal preview/apply를 제공한다. `/record-corrections`는 상태·시즌·팀·선수로
필터링하고 실행 중 job만 polling한다. proposal apply는 correction session만 변경하며 commit/import
API의 권위와 확인 절차를 우회하지 않는다.

## 11. 검증과 초기화

- V2 TypeBox contract, generated JSON Schema, canonical hash golden
- tracking duplicate/reused ID/conflict/provider ordinal drift/unlinked/multiple/missing/batch 회귀 테스트
- 야구 규칙 unit/property/golden
- revision 1->2, immutable history, stale base, current/all view, rollback, projection hash 통합 테스트
- NULL denominator, zone/chase, season 집계 SQL 테스트
- sanitized fixture 기반 collection/correction/import/replay E2E
- lint, format, typecheck, unit, architecture, schema, build, integration, E2E, performance, Compose health

테스트는 실제 Naver를 호출하지 않으며 고유 Compose project, 임시 workspace, 임시 volume을 사용한다.
모든 검증이 끝난 뒤에만 명시적으로 승인된 `.data`와 정확한 운영 PostgreSQL volume을 초기화하고
2024-01-01부터 2024-12-31까지 다시 수집한다. blocking 경기는 quarantine에 남고 교정이 끝난
경기만 revision 1로 적재한다.
