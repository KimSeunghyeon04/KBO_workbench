# KBO Workbench Web

Naver KBO 문자중계를 수집·정리·보정하고, 검증된 원장을 PostgreSQL의 분석·재생용 구조로
컴파일하는 개인용 로컬 웹 워크벤치다.

가장 중요한 경계는 다음과 같다.

```text
Naver 응답 -> immutable source bundle -> StagingGameDocumentV2 평면 원장
             -> tracking/원장 보정 -> 전체 compiler 검증
             -> versioned current(ready/quarantine/source_failure) -> V3 catalog + sealed PostgreSQL revision
             -> pitch/PA/play/runner/player-game 분석 fact와 replay

KBO Register/Trade -> gzip 원문 증거 -> registry season revision
                   -> 공식 player identity + 등록/소속 stint

KBO 기록정정현황 -> gzip 원문 증거 -> record_correction season revision
                 -> 경기/PA 후보 평가 -> correction batch 수동 승인
```

- JSON은 최종 경기 상태가 아니라 원천 중계를 정리하는 작업 원장이다.
- 원장의 이벤트는 Naver 중계 행과 1:1로 대응한다. 타석 결과와 주자 이동은 서로 다른 행이다.
- 아웃·주자·점수·타석·기록은 JSON에 중복 저장하지 않고 compiler가 계산한다.
- `sourcePitchId`는 유일하지 않은 출처 힌트다. tracking candidate의 identity는 결정론적
  `trackingId`이며 실제 pitch와의 관계는 교정 가능한 0..1이다.
- `sourcePitchOrdinal`은 Naver `ballcount` 원천값이다. 실제 PA 투구 순번은 compiler의 pitch fact가
  계산하며 두 값을 동일하다고 가정하지 않는다.
- 차단 finding이 없는 staging 원장만 새 append-only revision으로 적재한다.
- DB 적재 뒤 재생과 분석은 pitch·PA·play·movement·player-game fact를 사용한다.
- seal된 DB fact는 직접 수정하지 않는다. current revision을 draft로 reopen해 교정하고 다음 revision을
  적재한다.

## 실행

1. `.env.example`을 `.env`로 복사하고 로컬 DB 암호와 data directory를 설정한다.
2. Docker Desktop을 시작한다.
3. 저장소 루트에서 실행한다.

```powershell
docker compose up -d
```

브라우저에서 <http://127.0.0.1:8080>을 연다.

상태 확인과 일반 종료는 다음 명령을 사용한다.

```powershell
docker compose ps
docker compose logs -f api
docker compose down
```

`docker compose down -v`는 PostgreSQL volume을 삭제하므로 일반 종료에 사용하지 않는다.

## 경기 수집

`/collect`에서 날짜 범위 또는 시즌을 선택한다. 수집기는 일정, preview, relay, record를 읽고 모든
의미 있는 중계 행을 평면 typed 원장으로 보존한다.

선택 범위에 이미 `staging`으로 저장된 경기는 외부 요청 없이 건너뛴다. `quarantine`, 원천 실패와
아직 수집되지 않은 경기는 다시 수집하여 현재 결과로 분류한다.

- `적재 가능`: current manifest가 가리키는 strict/compile 통과 `ready` artifact
- `검토 필요`: current manifest가 가리키는 차단 finding 포함 `quarantine` artifact
- `원천 실패`: 필수 endpoint 또는 전송 자체가 실패해 원장을 만들지 못한 기록

공지·판독·휴식 같은 비상태 행도 원장에 남고, 안전하게 해석하지 못한 행은 원문과 원천 위치를
가진 `unresolved`로 남는다. 한 행의 실패 때문에 후속 중계를 버리거나 누락 결과를 합성하지 않는다.
반복·정정 여부와 관계없이 의미 있는 중계 행을 모두 원장에 남긴다. 같은 block의 동일 ID 투구와
tracking은 원천 occurrence 순서로 연결하고, 한 투구의 완전히 같은 tracking 재전송은 첫 관측을
canonical로 연결한 뒤 나머지를 `duplicate`로 보존한다. 같은 `sourcePitchId`가 경기 안에서 반복되면
경고와 모든 원천 위치를 표시하지만 그 ID만으로 행을 합치거나 적재를 차단하지 않는다.

endpoint 원문은 canonical JSON을 gzip으로 압축해 `.data/source`에 불변 저장하고 manifest에 endpoint,
응답 hash와 수집 시각을 남긴다. 최초 정리 원장과 당시 finding은 `.data/original`에 한 번만 저장한다.
현재 권위는 `.data/current/<gameId>.json` 하나가 `.data/active`의 versioned artifact를 가리킨다.
재수집으로 대체된 원장과 원천 실패는 `.data/superseded`에 generation/content-hash snapshot으로
보존하고, finding이 없으면 빈 envelope sidecar를 만들지 않는다. 자세한 내용은
[수집과 staging 운영](docs/collection-and-staging.md)을 참고한다.

## 경기 보정

`/correct`는 현재 staging·quarantine 원장과 명시적으로 선택한 superseded snapshot을 연다. 기본
화면은 검토가 필요한 경기만 표시한다.
이벤트 목록은 JSON 원장과 1:1이며 숨겨진 movement 하위 행이나 자동 생성 이벤트가 없다.

- 한 행 또는 최대 100개의 서로 다른 행을 한 번에 추가하고, 수정·삭제·위/아래 이동·위치 지정 이동
- 이닝·타석 단위 접기/펼치기와 finding 대상 행 자동 펼치기
- 기록정정 검토함에서 이동한 경우 KBO 공지 내용과 선수별 전후 공식 기록 표시
- `unresolved`를 원문과 원천 위치를 유지한 typed 행으로 교체
- roster와 공식 기록 수정
- 공식 기록 불일치의 팀·선수 식별과 타자·투수별 공식값/compiler 계산값 비교
- 타자·투수·주자·교체 선수의 경기 roster 검색
- Naver 원문 또는 사용자가 확정한 중계 문구 저장
- 선택한 투구 상세의 tracking 원천 위치·PTS 순번·metric·resolution 확인과 실제 예외의 연결·제외
- 원장 편집으로 삭제된 PA 시작을 가리키는 tracking 문맥의 명시적 일괄 재계산
- immutable source의 선택 행 주변 relay JSON과 같은 block 관련 PTS 원문 확인
- 명령 단위 undo/redo와 `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`

여러 행 추가는 드로어의 순서형 목록에서 각각 구조화해 작성한다. 제출 시 기존 batch 한 건으로
원자적으로 적용되며, 전부 성공하거나 전부 실패하고 한 번의 undo로 함께 되돌린다.

타석 결과 편집기는 결과와 타자·투수·타점·직접 기록 아웃·타자 생존 예외·타구 유형·번트 여부만
다룬다. 주자 이동은 별도 `runner_advance` 행으로 편집하고, 타석 플레이에 속하면 해당
`plateResultEventId`를 참조한다. 각 명령 뒤 서버는 작업 사본 전체를 다시 compile하고 finding을
교체한다. 차단 상태도 명시적으로 quarantine에는 저장할 수 있지만 staging 승격과 DB 적재는
불가능하다. 자세한 내용은 [보정 운영](docs/correction.md)을 참고한다.

동일한 투구 연결을 유지한 채 원장 편집으로 compiler PA 시작만 바뀌면, 편집 전 compiler 문맥과
일치하던 tracking 후보와 그 중복 후보는 새 PA를 따라간다. 이미 삭제된 PA ID를 가진 과거 작업본은
`삭제된 PA 문맥 재계산`으로 복구하며, 존재하는 다른 PA와의 실제 불일치는 계속 차단한다.

## 데이터베이스 적재

`/database`에서 검증된 staging 경기를 한 건씩 또는 현재 적재 가능한 문서 전체로 등록한다. 신규
경기는 revision 1, reopen·재수집한 교정본은 current+1이 된다. 일괄 적재는 서버가 staging을 다시
선별해 최대 2개씩 처리하며, 각 경기는 독립 transaction과
독립 job이어서 한 경기의 실패가 다른 경기를 중단하지 않는다. 각 적재 transaction은 다음 경계를
한 번에 수행한다.

1. 원장 strict decode와 전체 compile
2. Naver source identity와 경기 당시 팀·선수 이름 snapshot upsert
3. 원장 fact, 원자적 play, 최종 movement, play 전후 상태, PA lifecycle·bridge, 기록 projection
4. DB 재조회·V2 원장 hydration·recompile과 document/projection hash 검증
5. 새 revision seal과 current pointer 원자 전환

차단 finding이나 무결성 불일치가 있으면 전체 rollback한다. DB는 정리된 원장 행도 provenance로
보존하지만 공개 재생·분석은 typed fact를 직접 사용한다. 적재가 성공하면 같은 hash의 staging
작업본만 제거하고 immutable original/source 증거는 보존한다. 자세한 내용은
[PostgreSQL persistence 운영](docs/postgresql-persistence.md)을 참고한다.

DB V3는 경기와 독립된 `catalog` 팀·선수 entity를 두고 sealed fact는 변하지 않는 Naver source
identity를 참조한다. 이후 KBO 공식 ID에 연결해도 과거 projection hash는 바뀌지 않는다. tracking
측정치는 `tracking_observations`에 한 번만 저장하고 pitch에는 link만 둔다.
DB에서 다시 읽은 projection 행은 descriptor가 소유한 column 순서와 runtime decoder로 shape,
nullability, enum, safe integer, row count, game/revision 문맥과 key uniqueness를 확인한 뒤에만 hydration과
replay에 사용한다.

분석은 `game_id`가 아니라 `analytics.current_pitches`, `current_plate_appearances`,
`current_plays`, `current_runner_movements`, `current_player_game_*`,
`current_player_season_*`의 grain을 기준으로 한다. PostgreSQL은
`127.0.0.1:${KBO_DB_PORT:-5433}`에만 공개되며 `.env`의 별도 analyst 계정은 `analytics` 조회만
가능하고 기본 transaction이 read-only다. 예제는 [database/examples](database/examples)를 참고한다.

## KBO 선수 등록·이동 동기화

V3 DB 적재 뒤 2024 Register 일별 snapshot과 Trade 월별 이동 내역을 수집한다.

```powershell
pnpm registry:sync -- --season 2024
pnpm registry:sync -- --season 2024 --from 2024-03-23 --to 2024-10-01 --dry-run
pnpm registry:sync -- --season 2024 --resume <run-id>
```

기본 범위는 DB의 해당 시즌 sealed 경기 최소·최대 날짜다. 원문은
`.data/registry/source`에 gzip/hash manifest로 저장한다. 1군 등록과 구단 소속 stint는 분리되며,
일별 페이지 공백을 넘어 등록 stint를 추론하지 않는다. 개명·등번호 변경은 event만 남기고 소속
stint를 바꾸지 않는다. 모호한 동명이인은 병합하지 않고 resolution issue로 남긴다. 공개 Registry
API나 화면은 이 버전에 포함하지 않는다.

## KBO 기록정정 검토

`/record-corrections`는 KBO 기록정정현황을 수집해 `미반영`, `이미 반영`, `수동 검토`,
`지원 범위 외`, `DB 경기 없음`, `해결됨`, `무시됨`으로 분류한다. 서버는 마지막 성공으로부터
24시간 뒤 다시
확인하고, 기한을 넘긴 채 재시작하면 한 번 즉시 실행한다. 실패 후 재시도 간격은 6시간이다.
화면의 `지금 동기화`로 보유한 sealed 경기 시즌을 수동 확인할 수도 있다.

원문 landing HTML, control 응답과 모든 pagination JSON은
`.data/record-corrections/source/<season>/<run-id>/`에 gzip과 SHA-256 metadata로 저장한다. 중단된
run은 같은 request key의 검증된 artifact부터 이어가며, 필수 페이지를 모두 취득·파싱한 경우에만
season revision을 seal한다. 2024 정규시즌 공식 표는 12개 열과 10개 공지를 기준 fixture로
비식별화해 회귀 테스트한다.

검토함에서 확정 후보를 선택하거나 무시 사유를 남긴 이력은 append-only다. `보정 작업 열기`는
current sealed revision을 기존 correction draft로 열 뿐 DB fact를 바꾸지 않는다. 제안 패널의
`제안 적용`도 플레이와 지원되는 공식 타자·투수 기록을 correction session의 원자적 batch로만
적용한다. 타자·투수·야수의 지원 여부는 통계명뿐 아니라 기록 범위를 함께 판정한다. 예를 들어
투수의 `희비`는 피희생플라이 원문 증거로 보존하되 타자 희생플라이 기록으로 적용하지 않는다.
적용 가능한 플레이나 통계가 전혀 없는 공지는 `지원 범위 외`로 분류해 알림과 수동 검토 건수에서
제외한다. 전체 compile, proposal hash와 session/base/source hash 검사를 통과해야 하며, 이후
`현재 원장 저장`과 Database import는 기존 버튼으로 별도 확인한다. 야수 실책과 지원하지 않는
통계는 원문 증거로 보이지만 원장 기록에는 쓰지 않는다.

## 경기 재생

`/replay`는 current 또는 선택한 과거 sealed revision의 원자적 play frame을 재생한다. 타석 결과와 연결 주자 행은 같은
frame에 원장 순서로 표시되고 상태는 play 전후 한 번만 바뀐다. 투구, 독립 주자 이동, 교체와
반이닝 경계는 독립 play가 되며 공지·판독은 상태를 바꾸지 않는 재생 항목 또는 play 주석이 된다.

브라우저는 시즌과 월을 고른 뒤 경기 수가 표시된 달력 날짜로 seal된 DB 경기를 좁히거나, 경기 ID를
직접 검색해 카드 목록에서 고른다. frame page를 모두 받은 뒤 재생 위치와 속도를 로컬에서 관리한다.
DB catalog는 경기 날짜·팀·current revision·전체 revision 수를 한 번에 제공한다. 수집과 재생의 긴
목록은 viewport와 overscan 구간만 렌더링하고, Database는 최초 50경기만 점진적으로 표시하며 전체
revision hash 이력은 사용자가 해당 행을 펼칠 때만 조회한다.
경기 변경 패널은 현재 재생 위에 열리므로 새 경기를 불러오기 전까지 기존 화면을 유지한다.
점수·BSO·주자·현재 타자와 투수, PA, typed 주자 이동·수비진, tracking metric과 유효한 좌표가 있는
스트라이크 존을 확인할 수 있다. 자세한 내용은
[경기 재생 운영](docs/replay.md)을 참고한다.

## 백업과 복원

backup은 API writer를 멈춘 같은 시점의 파일 workspace와 PostgreSQL custom dump를 `.backups`에
저장한다. manifest의 app/migration은 compose 파일의 기대값이 아니라 실행 중인 API와 DB에서 읽어
기록한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
```

복원은 현재 workspace와 DB를 교체하므로 확인 switch가 필요하다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore.ps1 `
  -BackupDirectory .backups\kbo-workbench-YYYYMMDDTHHMMSSfffZ `
  -ConfirmDataReplacement
```

## 개발 품질 명령

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

DB V3 fresh bootstrap과 V2 current-only 전환 절차는
[PostgreSQL persistence 운영](docs/postgresql-persistence.md)에 있다. V2 volume은 삭제하지 않고 별도
V3 volume과 함께 보존한다.

## 문서

- [구현 명세](kbo_workbench_web_implementation_spec.md)
- [Game Core 규칙](docs/game-core-rules.md)
- [수집과 staging 운영](docs/collection-and-staging.md)
- [보정 운영](docs/correction.md)
- [PostgreSQL persistence 운영](docs/postgresql-persistence.md)
- [경기 재생 운영](docs/replay.md)
- [백업과 복원 운영](docs/backup-and-restore.md)
- [Windows Docker Desktop 설치](docs/windows-installation.md)
- [테스트와 성능 기준](docs/testing-and-performance.md)
- [ADR 0001](docs/adr/0001-local-web-modular-monolith.md)
