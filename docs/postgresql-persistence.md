# PostgreSQL V3 persistence와 분석

스트라이크존은 타자 키로 계산한다. 2024년까지는 2024 규칙, 2025·2026년은 2025 규칙을 사용하며
트래킹 존으로 대체하지 않는다. 키가 없으면 계산 불가다. [정책·구현·검증](strike-zone.md)을 따른다.
`0008_naver_player_heights`는 원문 해시에 묶인 키 관측과 dataset hash를 registry에 별도 봉인한다.
게임 projection 3/4와 기존 봉인 hash는 보존하며, 실제 계산은 `analytics.game_batter_heights`를 읽는다.
`0009_player_height_supplements`는 추출 버전 2, 불변 공식 프로필, 경기별 키 선택을 추가한다.
같은 경기 → 같은 시즌 동일 선수 ID → 검토한 공식 프로필 순으로 보완하며 충돌은 미확정으로 남긴다.
확정한 키와 FK로 연결한 출처는 수정·삭제할 수 없고, 새 관측으로 자동 교체하지 않는다.

적재의 projection 생성, DB 재조회 fact의 정규화·hash와 내부 재compile 뒤 projection 계산도
공용 worker에 위임한다. 각 계산 실패는 같은 DB transaction 전체를 rollback한다. descriptor의
column set은 table마다 준비하지만 모든 행의 strict scalar 검증과 V3/V4 canonical hash 규칙은
유지한다. 대시보드·적재 요약은 sealed current 경기 ID만 조회하고 수집 이력 상세는 해당 페이지의
game ID 조건으로 DB catalog를 읽는다.

서버는 적재 직전 및 DB fact 재구성 뒤의 전체 컴파일을 동일 compiler를 호출하는 CPU worker에
위임한다. DB 연결·projection 쓰기·재조회·seal은 기존 transaction 안에 있고 worker 실패도
전체 rollback한다. 적재 이력 복구는 최대 16개 파일씩 hash/decode하며 파일명 순서와 오류 순서를
유지한다. 목록은 생성 시각/ID 정렬을 재사용하고 상태는 현재 snapshot에서 읽으며 반환할 페이지만 복사한다.

## 권위와 bootstrap

관계형 fact INSERT는 descriptor 순서와 행·컬럼 순서를 유지한 채 최대 500행·60,000개 parameter로
묶는다. 전체 트랜잭션, 저장 후 재조회 hash·원장 재구성 컴파일·seal·rollback 계약은 동일하다.
DB 경기 목록은 시즌·문자열 검색·정렬·LIMIT/OFFSET을 SQL에서 처리한다. 페이지 개수와 전체 시즌은
별도 집계하며 staging 목록을 위해 DB 전체 경기의 팀·revision 정보를 읽지 않는다.

PostgreSQL은 검증된 `StagingGameDocumentV2`를 typed fact로 투영해 봉인한 분석·재생 정본이다. 원장과
공개 `/api/v2` 계약은 그대로이고 DB 계약만 다음과 같이 V3다.

- PostgreSQL 16
- fresh baseline: `database/v3/0001_v3_initial.sql`
- migration head: `database/v3/0020_official_pitcher_hands.sql`
- analytics/projection/registry/record correction contract: `4/4/1/2`
- schema: `catalog`, `workbench`, `baseball`, `registry`, `record_correction`, `analytics`
- JSON, JSONB, ARRAY, tracking EAV 컬럼 없음

V3 baseline은 빈 DB에만 적용한다. `database/migrations`의 V2 SQL은 backup 복구와 current export
검증용 legacy이며 V2 DB에 V3 DDL을 적용하지 않는다. Compose의 V3 volume은
`kbo-workbench-postgres-v3`, legacy 기본 volume은 `kbo-workbench_postgres-data`라 동시에 보존된다.
기존 V3 volume에는 미적용 migration을 순서대로 transaction으로 추가 적용하며 실패하면 API를 시작하지 않는다.

## Record correction provenance

`record_correction` schema는 collection run/season progress, immutable source season revision과 current
pointer, source page, notice/participant/stat change, match assessment/candidate와 append-only review
action을 scalar typed column으로 저장한다. JSON/JSONB/ARRAY는 사용하지 않는다. notice identity는
`season:seriesId:recordNumber`이며 내용 hash가 바뀌면 새 source revision이 생기고 해결·무시 상태는
재검토된다.

자동 수집은 마지막 성공 24시간 뒤, 실패 6시간 뒤 실행한다. 서버 재시작 때 queued/running run은
`.data/record-corrections/source/<season>/<run-id>/`의 gzip·SHA-256 metadata를 검증해 남은 request부터
이어간다. cancelling 상태로 중단된 run은 재개하지 않고 cancelled로 닫는다. 필수 control/page가
모두 파싱된 경우에만 source revision을 seal하며 같은 bundle hash면 run을 `no_change`로 닫는다.

정정 적용은 이 schema나 기존 sealed fact를 직접 갱신하지 않는다. current game revision을 correction
draft로 hydrate하고 기존 compiler·workspace commit·append-only import를 거친다. import 성공 후
현재 봉인본과 활성 공지를 재평가해 KBO 정정 후 값을 충족하면 applied revision을 기록한다.

파일 적재 작업은 접수할 때 경기, revision, 원장 hash, 작업본 generation과 content hash를 고정한다.
봉인과 작업 식별자 저장은 같은 PostgreSQL 트랜잭션에서 커밋한다. 응답 유실이나 재시작 뒤에는
해당 작업의 봉인 기록으로 결과를 확인한다. 조회에 실패하면 결과 확인 대기로 표시하고 자동
재확인과 화면의 재시도를 제공한다. 봉인 결과 재확인 요청(`scope=publication`)은 저널에 확정된
결과를 받으며 후속 작업의 완료를 기다리지 않는다.
같은 경기의 후속 적재는 결과가 저널에 확정될 때까지 대기한다.
예약·취소·재대기를 작업별로 처리하며 보류된 경우에는 대기열만 갱신한다. 취소된 잠금 대기 작업은 적재 슬롯을 반환한다.
봉인 결과 확인, 파일 정리, 기록정정 재평가는 각각 처리한다. 파일 정리는 일치하는 세대의 작업본에만
적용하고, 다른 경기의 재평가 때문에 파일 정리나 봉인 확인을 기다리지 않는다. 정리 오류 뒤 새 작업본을 저장할 때는 같은 경기의
남은 파일 저널을 먼저 처리한다.

## Catalog와 불변 경기 snapshot

`catalog`는 경기와 독립된 전역 entity다.

- `competitions`, `seasons`, `teams`, `team_identities`, `team_name_observations`, `team_seasons`
- `players`, `player_identities`, `player_name_observations`
- `venues`, `tracking_measurement_profiles`

외부 identity key는 `naver:<external-id>` 또는 `kbo:<external-id>`다. KBO 공식 `playerId`가 확인되면
canonical player는 `kbo:<playerId>`, 그 전에는 Naver identity를 provisional entity로 둔다. 이름만
같거나 같은 강도의 후보가 둘 이상이면 병합하지 않는다.

sealed 경기 fact는 변경 가능한 canonical ID가 아니라 불변 Naver source identity를 FK로 참조한다.
따라서 나중에 Naver identity가 KBO canonical player에 연결되어도 과거 projection hash는 바뀌지
않는다. `workbench.game_team_snapshots`, `game_roster_snapshots`, `game_roster_positions`는 경기 당시
source ID와 표시 이름을 보존해 DB에서 V2 원장을 완전히 복원한다.

## Typed fact와 tracking

`workbench`는 revision manifest, 원장 header/kind subtype, 공식 기록, 검증 결과와 원천 tracking
관측을 저장한다. `baseball`은 `plays`, `play_events`, `runner_movements`, PA와 pitch bridge, 최종 상태,
타격·투구·주루 game fact를 저장한다.

tracking scalar는 `workbench.tracking_observations`에 한 번만 저장되고
`catalog.tracking_measurement_profiles`를 참조한다. `baseball.pitch_tracking_links`는 pitch와 원천
관측의 키만 연결하며 좌표를 복제하지 않는다. zone/chase는 `supports_zone=true`인 profile에서만
계산되고 지원되지 않는 profile은 `NULL`이다.

`0005_tracking_plate_height`는 zone formula를 2로 수정한다. `cross_plate_y`는 플레이트의 종방향
위치이고 높이는 `y(t)=cross_plate_y`의 첫 비음수 해에서 계산한 `z(t)`다. SQL의
`analytics.tracking_in_zone`과 재생은 같은 궤적·존 경계 규칙과 회귀 사례를 사용한다. 높이 계산에
필요한 값이 없거나 비정상·교차 불가·지면 아래·잘못된 존 경계이면 `in_zone`과 `chase`는 `NULL`이다.
존 안팎을 판별할 수 있는 실제 투구만 Zone% 분모에, 그중 존 밖의 모든 실제 투구를 Chase% 분모에
포함한다. 스윙한 존 밖 투구가 Chase% 분자다. 비스윙 행의 `chase`는 기존처럼 `NULL`이다.
analytics/projection 계약 `4/4`와 view 컬럼은 유지하며 기존 migration 파일·봉인된 측정값·revision·hash를
수정하지 않는다. 정상 배포 migration 적용 후 기존 current 경기의 분석 view도 새 계산식을 사용한다.
`0006_tracking_zone_parallel_safety`는 overflow 처리용 EXCEPTION 블록이 subtransaction을 시작하므로
함수를 `PARALLEL UNSAFE`로 지정한다. leader에서도 병렬 작업 중 subtransaction은 허용되지 않으므로
`PARALLEL RESTRICTED`로 대체하지 않는다. 공식과 반환값, view 컬럼, 봉인 기록은 바꾸지 않는다.

## Game revision import

`0004_pitch_metadata`는 `workbench.relay_pitches`와 `baseball.pitch_facts`에 nullable
`speed_kph`, `pitch_type`을 추가한다. 신규 revision은 projection 4로 봉인하고 V3는 고정된 이전
descriptor 컬럼 목록으로 read/hash/hydration한다. compiler는 하나이며 기존 manifest와 sealed 행은
변경하지 않는다. metadata가 없는 V4 행은 SQL NULL, 원장 hydration에서는 선택 속성 생략이다.
`analytics.current_pitches`와 `all_revision_pitches`에 두 컬럼이 노출되고
`database/examples/pitch-type-distribution.sql`은 구종별 투구·구속 표본·평균·헛스윙률을 계산한다.

한 import transaction은 다음을 모두 수행한다.

1. V2 strict decode와 전체 compile, blocking 거부
2. source identity와 당시 이름 관측 upsert
3. revision snapshot과 typed fact projection/hash 저장
4. DB projection 재조회와 hash 검증
5. typed ledger hydration, strict decode, 전체 recompile
6. document/projection hash 재검증
7. revision seal과 current pointer 전환
8. commit

실패하면 전부 rollback한다. sealed revision, manifest와 종속 fact는 trigger가 UPDATE/DELETE/후속 INSERT를
거부한다. 공개 replay는 typed play/movement/PA/tracking fact에서 만들고 staging ledger hydration은
import 무결성 검증에만 사용한다.

projection descriptor는 각 table의 SQL column 순서뿐 아니라 runtime row decoder와 primary-order key를
함께 소유한다. 재조회 행은 정확한 column shape, nullability, enum, boolean, finite number/safe integer,
rowCount, 요청 game/revision과 key uniqueness를 통과해야 한다. manifest도 provider, contract version,
hash, 날짜와 seal 타입을 decode한다. 위반은 `PersistenceIntegrityError`이며 partial replay나 seal을
만들지 않는다.
경기일은 PostgreSQL `DATE`의 달력 날짜를 유지한다. DB 드라이버가 현지 자정으로 읽은 값은
해당 연·월·일을 사용해 hydrate·재생·목록에 같은 경기일을 전달한다.

## Registry provenance

`pnpm registry:sync -- --season 2024`는 V3 DB의 해당 시즌 경기 최소·최대 날짜를 기본 범위로 삼는다.
`--from`, `--to`, `--dry-run`, `--resume <run-id>`를 지원한다. Register는 날짜×10개 구단 snapshot,
Trade는 겹치는 월의 pagination을 수집한다.

원문 HTML/JSON은 `.data/registry/source/<season>/<run-id>/`에 gzip과 SHA-256 metadata로 원자 저장하고
DB `registry.source_pages`에는 artifact key와 hash만 저장한다. 필수 페이지 취득·구조 파싱 또는 빈
등록 snapshot은 season revision seal을 막는다. resume은 같은 request key의 gzip 원문 hash가 같을
때만 재사용한다.

`registry.player_team_stints`는 다음 두 의미를 분리한다.

- `first_team_registration`: 연속된 완전한 일별 snapshot으로만 계산하며 누락일을 건너지 않는다.
- `organization_affiliation`: 명시적인 소속 시작·종료 event만 반영한다.

개명·등번호 변경 같은 `affiliation_effect=none` event는 stint를 바꾸지 않는다. Trade 행만으로 방향을
추측하지 않으며 warning issue로 남긴다. 선수 식별 모호성은 원문 season revision seal을 막지 않지만
해당 stint 생성에서는 제외한다. 범위 양끝 stint는 left/right-censored 상태를 가진다.

### 선수 경력 원문과 확인 기준

선수 검색의 경력 보조자료는 KBO 선수 프로필과 2017년 이후 KBO 선수 이동 페이지에서 수집한다.
필요한 초기 이적일은 선수 ID와 이동 방향이 확인된 구단 공식 원문으로 보완한다. 경기 봉인 기록과
공식 경력 보조자료의 출처는 각각 유지한다.

프로필의 입단년도와 입단 구단, 경력에 나온 구단 순서, 가장 최근 성적에 나타난 소속 구단과
출전 시즌을 사용한다. 수집 경기에서 확인한 시즌·구단 이력이 그 범위와 맞아야 한다. 같은
프랜차이즈의 명칭 변경과 확인된 군 복무팀은 이적으로 계산하지 않는다. KBO 이적 방향이
명시된 이동 행과 같은 원문에서 기존 팀의 FA 자격 및 새 팀 계약이 함께 확인된 경우에 날짜를
연결한다. 동명이인 이동일은 선수 식별 근거를 검토한 공식 원문이 있어야 한다. 해외 경력,
마지막 출전 시즌 또는 구단 변경일을 확인하기 어려운 선수의 리포트 기간은 `수집 기록`으로 표시한다.

서버를 빌드한 다음 현재 선수 목록을 저장해 두 명령을 실행할 수 있다. `workRoot`는 작업
사본의 루트이며 수집 ID가 같으면 해시가 맞는 원문을 재사용한다. 검토 파일은 기본값으로
`[]`를 쓸 수 있고, 구단 공지로 날짜를 보완할 때는 수집한 HTML을 옆에 둔다.

```powershell
curl.exe -fsS http://127.0.0.1:8080/api/v2/analysis/players -o directory.json
node apps/server/dist/maintenance/collect-official-player-careers.js directory.json workRoot career-run-id
node apps/server/dist/maintenance/build-official-player-careers.js directory.json workRoot career-run-id reviewed-moves.json
node apps/server/dist/maintenance/build-official-player-birth-years.js directory.json workRoot career-run-id
```

검토 항목은 `playerId`, `name`, `from`, `to`, `date`, `url`, `localHtml`, `proof`를 갖는다.
원문과 SHA-256 메타데이터는 `registry/player-careers/source/<수집 ID>/`에 보존한다.
브라우저에서 사용하는 보조자료는 `registry/player-careers/verified.json`이며 버전, 검증된
경력과 원문 키·해시를 담는다. 작업 사본의 원문과 검증 결과를 같은 상대 경로로 배치하면
다음 디렉터리 조회부터 반영된다.
출생연도는 같은 수집 ID의 KBO 프로필에서 읽어 `registry/player-careers/birth-years.json`에
보관한다. 개명 등으로 기록 이름이 다르면 KBO의 이전 이름 검색에서 ID와 공식 프로필 이름을
대조하고 그 원문을 함께 저장한다. 출생연도만 검색 API에 전달한다.

## Analytics와 analyst 권한

`analytics.current_*`와 `all_revision_*` pitch·PA·play·movement·player game view, 기존 시즌 집계 view를
유지한다. raw `player_id`/`team_id`와 source identity key를 보존하고 현재 catalog mapping의 canonical
ID를 함께 노출한다. 비율은 numerator/denominator를 함께 제공하고 분모 0은 `NULL`이다.

별도 analyst 계정은 database CONNECT와 `analytics` USAGE/SELECT만 가지며
`default_transaction_read_only=on`이다. `catalog`, `registry`, `workbench`, `baseball` 직접 접근과 DML은
허용하지 않는다.

## V2 current-only 전환

전환 전 [백업과 복원](backup-and-restore.md)에 따라 V2 DB와 `.data`의 짝 backup을 만든 뒤 API/writer와
journal을 정리한다.

```powershell
pnpm db:v3:export-current -- --source-dsn <V2 DSN> --backup <backup-dir> --output <export-dir>
pnpm db:v3:load-current -- --target-dsn <V3 DSN> --input <export-dir>
pnpm db:v3:verify-current -- --target-dsn <V3 DSN> --input <export-dir>
```

exporter는 V2 current projection/document hash를 먼저 재현하고 원래 revision/hash를 manifest에
기록한다. loader는 `revisionBase`만 `new_game`으로 바꿔 모두 V3 revision 1로 import한다. source
content, normalized ledger, compiler, replay semantic hash와 source bundle을 다시 비교한다. 기존 V2
revision 이력은 backup에만 남고 최신 current 교정 내용은 V3 revision 1 원장에 포함된다. target에
manifest 밖 경기가 있거나 count, seal, current revision 1 검증이 다르면 전환하지 않는다.

V2 volume을 별도로 열어야 할 때는 `compose.v2-legacy.yaml`과 명시적
`KBO_V2_VOLUME_NAME`을 사용한다. 어느 단계든 실패하면 V3 전환을 멈추며 V2 volume, backup과 원천
파일을 변경하지 않는다.

## API

DB 경기 목록은 `GET /api/v2/database/games`에서 authority·season·search·page·limit로 조회한다.
전체 원장 hydration/compile 없이 표시 요약과 DB catalog를 사용한다. `POST /api/v2/import-selections`는
조건 또는 기존 선택의 포함/제외 집합을 확정한다. `POST /api/v2/import-jobs/batch`는 선택 ID와 요청 키를
받고, `GET /api/v2/import-history`는 batch·상태·검색 필터와 페이지(50/200), 진행 집계를 반환한다.
`POST /api/v2/import-batches/:batchId/cancel`은 대기 작업만 취소하며
`POST /api/v2/import-jobs/:jobId/reconcile`은 저장 성공 후 남은 정리만 수행한다.

행정 code의 `called_game` 확장은 기존 text fact에 저장한다. analytics/projection 4/4와 migration
`0015_strike_zone_rule_fallback`를 사용한다. 계산 수정 전 봉인 자료는 기존 descriptor와 저장 hash로 검증·재생한다.
새 컴파일 결과 반영은 current draft를 열어 append-only revision으로 수행한다.

공개 game/replay/correction API와 `playerId` 의미는 기존 `/api/v2` 그대로다. 기록정정 전용 API와
검토함만 추가한다. Registry API와 웹 화면,
Savant식 wide search, RE24/WPA, percentile/qualification leaderboard는 이 버전에 포함하지 않는다.

Database 운영 콘솔은 catalog 요약만으로 적재 대기·저장 경기·작업 기록을 공통 고정 높이 가상
목록에 표시한다. 행에는 반복 행동 버튼을 두지 않으며 단건 적재, current 교정 초안, 원천 재수집,
revision 선택과 작업 오류는 선택 상세에서 수행한다. 저장 경기 revision endpoint는 항목 선택 뒤에만
호출한다. 검색·시즌·범위·선택은 URL 검색 파라미터가 정본이며 모바일에서는 목록과 상세를 번갈아
표시한다. 1,000px 이하에서는 선택 상세가 문서 스크롤을 따라 이어지며 내부 세로 스크롤을 만들지
않는다. 목록은 가상 행 탐색을 위한 높이를 유지하고 `목록으로`는 기존 활성 행과 목록 포커스를
복원한다. 직접 링크로 상세를 연 경우에도 같은 행으로 돌아가며 Enter·Space로 다시 열 수 있다.
넓은 화면의 목록·상세는 기존 높이 제한 안에서 각각 스크롤한다.
