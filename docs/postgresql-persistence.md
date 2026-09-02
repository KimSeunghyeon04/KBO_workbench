# PostgreSQL V3 persistence와 분석

## 권위와 bootstrap

PostgreSQL은 검증된 `StagingGameDocumentV2`를 typed fact로 투영해 봉인한 분석·재생 정본이다. 원장과
공개 `/api/v2` 계약은 그대로이고 DB 계약만 다음과 같이 V3다.

- PostgreSQL 16
- fresh baseline: `database/v3/0001_v3_initial.sql`
- migration head: `database/v3/0003_record_correction_scope_classification.sql`
- analytics/projection/registry/record correction contract: `3/3/1/2`
- schema: `catalog`, `workbench`, `baseball`, `registry`, `record_correction`, `analytics`
- JSON, JSONB, ARRAY, tracking EAV 컬럼 없음

V3 baseline은 빈 DB에만 적용한다. `database/migrations`의 V2 SQL은 backup 복구와 current export
검증용 legacy이며 V2 DB에 V3 DDL을 적용하지 않는다. Compose의 V3 volume은
`kbo-workbench-postgres-v3`, legacy 기본 volume은 `kbo-workbench_postgres-data`라 동시에 보존된다.
기존 V3 volume에는 `0002`만 transaction으로 추가 적용하며 실패하면 API를 시작하지 않는다.

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
assessment만 재평가해 승인 hash와 KBO 정정 후 값이 맞을 때 applied revision을 기록한다.

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

## Game revision import

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

공개 game/replay/correction API와 `playerId` 의미는 기존 `/api/v2` 그대로다. 기록정정 전용 API와
검토함만 추가한다. Registry API와 웹 화면,
Savant식 wide search, RE24/WPA, percentile/qualification leaderboard는 이 버전에 포함하지 않는다.
