# KBO Workbench Web V2 구현 명세

스트라이크존은 타자 키로 계산한다. 2024년까지는 2024 규칙, 2025·2026년은 2025 규칙을 사용하며
트래킹 존으로 대체하지 않는다. 키가 없으면 계산 불가다. [정책·구현·검증](docs/strike-zone.md)을 따른다.
키는 검증된 네이버 명단과 중계 내부 선수 기록에서 추출한다. 같은 경기, 같은 시즌의 동일 선수 ID,
검토한 공식 프로필 순으로 보완하고 경기·원문 해시·선수 ID별 채택값과 출처를 DB에 고정한다.
상위 근거가 충돌하면 하위 근거로 덮지 않는다. 새 자료는 기존 선택을 바꾸지 않는다.
웹 신규 가져오기는 경기·키·선택을 원자 저장하고, 기존 경기는 명시적 보충 명령으로 추가한다.

## 1. 목적과 권위

책임 투수 표시: 보정 API의 `eventContexts[].runnerMovement`는 적용된 compiler movement의
주자와 최종 책임 투수를 전달한다. 웹은 그 이름을 표시하고 별도 책임 계산이나 payload 자동 저장을
하지 않는다. 미적용·새 이동 또는 수정 중인 이동은 반영 후 확인하도록 표시한다. 포스 병살에서도
기존 주자의 책임 슬롯을 생존 주자에게 승계하고 후속 득점까지 유지한다.

중계 문구 교정: source 행도 `replace_event`에서 명시한 `relayText`를 저장한다. 문구 생략 시 현재
값을 유지하며 immutable source bundle과 최초 원본은 덮어쓰지 않는다. 원장·검색·재생은 보정 문구를
사용하고 근거 패널은 최초 원문을 보여준다. 문구만 수정하면 기존 payload·관측·identity를 보존하며
텍스트를 다시 파싱해 경기 상태를 바꾸지 않는다. 기존 전체 compile·version·undo/redo·저장을 따른다.

관측값 교정: source 행의 `observedStateAfter`는 전용 `update_observed_state` 명령으로 명시적으로
수정할 수 있다. immutable source bundle과 최초 원본은 보존하고 일반 `replace_event`는 기존 관측을
유지한다. 웹은 숫자·베이스 구조화 입력만 제공하며 관측 단독 변경은 전용 명령, 이벤트와 함께 변경은
atomic batch로 전달한다. 전체 strict compile 및 session version/undo/redo/commit을 유지한다.
빈 값은 비교 생략, 0은 관측된 값이다. 관측은 보정 뒤에도 계산 상태를 덮어쓰는 입력이 아니다.

주자 편집의 선수·출발 베이스 연동은 상대 필드가 비어 있거나 자동 지정 상태인 경우만 적용한다.
기존 원장 값과 사용자 선택은 보존하므로 같은 플레이의 연속 진루를 입력할 수 있다. 플레이 시작 전
베이스는 추천 근거이며 중간 이동 상태의 권위가 아니다. 이동 적합성은 전체 compiler가 검증한다.

성능 경계: 원문 읽기·canonical/hash 검증, 보정 snapshot 준비, DB projection 정규화·hash는
API thread와 분리한 제한된 worker에서 처리한다. 계산 결과가 준비된 뒤에만 세션 version과
history를 변경하며 DB 쓰기·검증·seal의 transaction은 유지한다. 원문 cache의 byte 수도 worker에서
계산한다. 검증된 원본은 worker마다 16MiB/4건, idle 5분 범위에서 보관하고 선택 행의 근거만
API에 전달한다. 분석 worker는 chunk 행을 순서대로 한 번씩 추가한다. 수집 이력의 검증된 정렬 목록은
32MiB/20,000건 이내에서 재사용하고 writer 변경·실패로 무효화하며 페이지 사본만 반환한다.
화면용 상태 검사는 최대 500ms의 절대 만료 시간을 사용해 공유하고 readiness는 새로 검사한다.
숫자 집계는 DB 경기 ID를, 수집 이력 상세는 해당 페이지의 경기 요약을 조회한다.

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
API composition root의 최대 2개 지속 worker는 같은 compiler·correction·collection 공개 진입점을
호출한다. 대기열은 32개, 실행 제한은 60초이며 과부하는 재시도 가능한 503으로 반환한다. 취소·실패는
세션이나 DB를 부분 반영하지 않는다. 파일 writer와 PostgreSQL transaction은 원래 소유자가 유지한다.
투수 표본 계산은 별도 worker 1개·대기 16개로 제한하고 시즌 행은 5,000개씩 전달한다.
재생 목록은 database authority만 요청한다. 적재 이력은 hash/decode를 보존한 16개 병렬 읽기와
생성 시각·ID의 정렬 인덱스를 사용하며, 변경되는 상태는 현재 job snapshot에서 읽는다.

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

제공자 preview의 숫자 상태 `0`·`4`는 relay summary의 type 99 종료 footer와 3아웃 관측이
함께 있을 때만 `final`로 해석한다. 코드만으로 종료를 추정하지 않으며, 원장·공식 기록·종료 조건은
기존 compiler가 다시 검증한다. 실제 상태 `4` 응답의 비식별 fixture로 증거 누락 거부도 확인한다.

수집한 endpoint payload는 canonical JSON 후 gzip으로 `.data/source/<season>/<gameId>/`에 불변
저장한다. manifest에는 endpoint, 응답 hash와 최초 수집 시각을 기록한다. 같은 source bundle hash로
현재 DB revision을 재수집하면 새 draft나 revision을 만들지 않는다. hash가 바뀌면 current revision을
base로 하는 기록정정 draft를 만든다.

모든 의미 있는 relay 행은 typed event, review/administrative 또는 `unresolved` 중 하나로 보존한다.
알 수 없는 행을 버리거나 누락된 타석 시작·투구·결과·주자 이동을 만들지 않는다. provider 별칭,
한국어 문장과 정규식은 collection에만 둔다.

타석 결과 본문의 `실책으로 출루`는 일반 땅볼 출루보다 구체적인 근거다. 구조화 결과가 없거나
`field_out`·`fielder_choice`인 경우에는 해당 문구의 결과 후보를 일반 출루와 같은 강도로 평가하고,
기존 specificity로 실책·희생타·낫아웃 등의 복합 결과를 구분한다. 괄호 안 부연의 실책 출루 문구만으로
이 우선순위를 올리지 않으며, 구체적인 구조화 결과와 원문·identity·주자 이동은 보존한다.
수정된 정규화는 기존 sealed revision을 자동 갱신하지 않는다. 기존 데이터 교정은 current를 reopen한
원장에 structured command를 적용하고 전체 검증 뒤 새 revision을 적재하는 절차를 따른다.

## 5. Tracking candidate

tracking candidate는 다음 typed 정보를 가진다.

- 결정론적 `trackingId`, endpoint/block/row source 위치
- 선택적이고 non-unique인 `sourcePitchId`
- nullable Naver `ballcount` 원천값인 `sourcePitchOrdinal` — PTS 관측 순번일 수 있으며 실제 PA
  투구 순번이 아님
- inning, half, PA, 선택적 투수·타자, stance
- `x0/y0/z0`, `vx0/vy0/vz0`, `ax/ay/az`
- `crossPlateX/crossPlateY`; 새 수집에서는 `topSz/bottomSz`를 폐기한다
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

### 5.1 시즌 평균 포심 비교

시즌 평균 포심 도착 순간의 읽기 전용 분석은 `/analysis/pitch-shape`에 구현한다. 2020–2025년 각각의
current actual pitch 중 `직구`를 포심 기준 집단으로 사용한다. 초기 위치·거리 방향 접선을 정렬한
평균 궤적의 도착 시각 T에서 대상 공의 X–Z 상대 위치와 플레이트까지 Y 거리를 회전 가능한 3D로
표시한다. 중계 구종/클러스터 색상을 전환하며 개별 시간차는 선택 상세에 표시한다. 군집은 투수·시즌의
전체 유효한 X/Z/Y를 표준화한 full-covariance GMM으로 계산하고 원표기를 보존한다.
기본 K는 유효 투구의 중계 구종 수(희소 구종 포함, null 제외)이며 군집 수 선택 즉시 재계산한다.
투수·시즌 변경은 기본 K를 복원하고 URL의 clusterCount는 수동 선택을 보존한다. 군집 모델 버전은
2이며 설정한 K와 실제 배정 군집 수, 미수렴을 구분한다. 서버는 DB 연결 반환 뒤 최대 2개의 worker로
계산하며 sourceHash·투수·K·모델 설정별 최대 32개 결과를 메모리에 재사용한다.
상단 데이터 관리/분석 영역에 메뉴를 나누며 경기 재생은 분석에 포함하고 영역별 마지막 주소를 복원한다.
분석의 최초 진입은 `/analysis/players`의 선수 탐색이며, 선택한 선수의 기능은 공통 분석 항목에서 이동한다.
기준은 투수·구종 필터와 독립이며 빠른 공은 통과 후 외삽으로 표시한다. 계산·제외 기준,
같은 시각의 의미, sourceHash와 읽기 API 계약은 [투구 움직임 분석](docs/pitch-shape-analysis.md)을 따른다.
포심 기대 비교는 같은 snapshot의 시즌 포심으로 3D 공분산과 경험적 50%·90% 타원체를 만든다.
순수 game-core 계산을 사용하고 기준 분포는 referenceVersion 2로 보존한다. 궤적 modelVersion 2와
GMM modelVersion 2는 유지한다. 실제 포함 수와 표본 수를 함께 반환하며 4구 미만은 분포 null이다.
DB의 swing/whiff fact를 그대로 연결하고 서버에서 구종·군집·분포 구간별 위치·시간 평균/표준편차와
헛스윙/스윙을 집계한다. 분모 0은 null이며 웹에서 —로 표시한다. 시점·확대·필터는 기준 분포를
바꾸지 않는다. 표의 그룹 필터와 투수 전체 분포 구간 집계의 범위를 명시하고 미보정 관측값으로 설명한다.
기존 analytics/projection 4/4와 DB migration, 봉인된 fact를 변경하지 않는다.
투구 움직임은 중간면 17/24ft로 통일하고, 같은 시즌의 경기일 이전 84일·반감기 7일 가중 회귀로 구장 편향을 차감한다.
투수×구종×월 고정효과와 구속·좌타 비율·카운트를 통제한다. 9개 주 구장이 모두 최소 5경기·20투수를
충족하고 편향 대비가 식별 가능할 때 적용하며, 부족 날짜/미지원 구장의 유효 투구는 미보정으로 표시한다.
계수는 `analysis/pitch-calibration/v1/<season>/<sourceHash>.json`에 저장하고 sourceHash 변경 후 첫 요청에서
bounded worker로 갱신한다. 날짜별 과거 입력 해시가 같으면 재사용하며 미래 자료를 사용하지 않는다.
평균 포심·기준 분포·대상 투구에 동일 보정을 적용하며 원천 fact와 타자 선구안은 보존한다.
시즌 기준 궤적과 요약은 workspace의 `analysis/pitch-reference/v<modelVersion>/reference-v<referenceVersion>/<calibrationHash 또는 source-plane>/<season>/<sourceHash>.json`에
저장한다. 요청마다 같은 DB snapshot의 current revision 목록으로 키를 검증하고 일치하면 대상 투수만
조회한다. 누락·손상·버전 또는 sourceHash 변경 시 결정론적으로 다시 계산한다. 저장은 workspace writer
lock과 atomic write를 사용하며 파일은 봉인된 fact로부터 재생성할 수 있는 파생 캐시다.

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

`final` 문서의 예정 이닝 이상 말 공격에서 홈이 앞서고 이후 판독·안내 외 진행 행이 없으면, 마지막
타석/독립 주루 play의 종료 잔루 관측만 비교에서 제외한다. 계산된 주자와 원문은 보존하며 이동을
합성하지 않는다. 점수·아웃·볼카운트·공식 기록의 기존 검증 경계는 유지한다.

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
초안 열기는 현재 작업본을 우선 보존한다. 작업본이 없으면 평가 당시 revision과 DB current를 비교해
달라진 경우 경기·타석을 재매칭하고 현재 revision을 base로 연다. 재매칭이 불확실하면 후보 확인으로
돌려보내며 기존 작업본의 base를 자동 전환하지 않는다.
기록정정 목록·상세의 선택 필드 `draftProgress`는 저장된 작업본을 서버에서 검증한 진행 상태다.
정정 후 조건, 차단 없음, 현재 DB base 일치를 모두 만족하면 `DB 적재 대기`와 해당 경기 적재 링크를
표시한다. 미저장 session은 반영하지 않고 차단·미완성·stale base를 구분한다. 조회는 영속 case 상태를
바꾸지 않으며, 저장/적재 완료 뒤 관련 화면을 갱신한다.
이닝·타석 접기 또는 펼치기는 해당 그룹 시작 행을 선택한 뒤 가상 목록을 갱신한다.
기록정정 공식 기록 비교는 field descriptor가 정한 생략 의미를 사용한다. 비발생 선택 계수는 0,
coverage 부재 가능 필드는 미제공으로 유지하며 원천 원장과 projection hash는 변경하지 않는다.
생략된 선택 계수의 0이 공지 전후와 모두 다르면 KBO 정정 후 값으로 보완하는 명시적 제안을
제공한다. 명시된 기존 값의 충돌과 coverage 누락은 보완하지 않는다. 제안은 선수명·통계명·
미제공 여부를 표시하며 기존 원자적 command와 검증·undo/redo·저장·적재 경로를 따른다.
명령이 없는 제안도 지원 통계의 공식값과 compiler 계산값이 정정 후 값인지 확인한다. 자책점은
공식값만 검증하며, 계산값 차이를 해결할 근거 있는 batch가 없으면 수동 검토로 남긴다.
`반영 필요`는 실제 적용 가능한 batch가 있는 경우만 표시한다.
타석 매칭은 이전 교체 행의 명시 또는 승계 타순을 확인하고 수비 위치만 바뀌어도 유지한다.
여러 투수의 공식 기록은 같은 팀의 개별 이름에 연결하며 참가자 나열 순서에 의존하지 않는다.
통계 지원 여부는 scope와 stat code 조합으로 판정하고, 투수 피희생플라이처럼 현재 집계하지 않는
항목은 원문 증거로만 보존한다. 적용·검증 가능한 변경이 전혀 없는 공지는 `지원 범위 외`로 분류해
수동 검토 알림에서 제외한다.
시즌을 생략한 기록정정 수동·예약 job은 보유 sealed 시즌 중 공식 공지 서비스 시작 연도인
2022년 이후만 선택한다. 명시한 과거 시즌은 자동 제외하지 않고 기존 공식 control 검증을
수행한다. 제도 이전의 빈 응답을 완전한 source revision으로 봉인하지 않는다. 공지 원문을
유지하면서 괄호 안 통계 항목 줄바꿈과 괄호 뒤 쉼표만 해석하며 불완전·모호한 그룹은 연결하지 않는다.
blocking draft는 quarantine에만 commit할 수 있다. sealed revision은 직접 수정하지 않고 correction
draft로 reopen한 뒤 새 revision으로 적재한다.
DB revision의 correction draft 열기는 workspace가 주입된 compiler로 한 번 검증하고 결과에 따라
ready/quarantine을 선택한다. 서버는 공용 bounded worker를 주입하며 route에서 재컴파일하지 않는다.
검증이 실패하면 original/current를 쓰지 않는다. 기존 저장 API의 blocking 거부와 current 전환 검증은
유지한다. 기록정정 저장소는 jobs, sources, cases 내부 모듈을 공개 repository가 조립하며 SQL과
트랜잭션 경계를 유지한다. 보정 drawer의 상태·명령 조정과 종류별 입력 UI도 별도 모듈이 소유한다.

`lifecycle=while_event_unresolved` finding은 대응 행이 현재도 `unresolved`일 때만 현재 차단으로 병합한다. 사람이
typed 행으로 교체하거나 명시적으로 삭제한 행의 finding은 immutable original의 저장 당시 기록에는
남지만 현재 작업본의 차단으로 승계하지 않는다.

## 8. PostgreSQL V3

활성 DB는 PostgreSQL 16에 `database/v3/0001_v3_initial.sql`을 적용하고 migration head
`database/v3/0012_competition_game_links.sql`까지 올린다.
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

매치업 확장은 기존 관측 통계와 별도 계약·API·접이식 패널로 제공한다. A10의 고정 전처리·
구질·코스 계산을 공유하고 타자별 logit offset은 별도 시간 검증과 소표본 축소를 통과해야 한다.
학습은 DB 읽기와 계산을 같은 maintenance worker에서 수행해 원시 행을 다른 heap에 복제하지
않으며 DB 연결은 계산 전에 반환한다. 새 모델은 base 모델 hash와 원천 manifest에 결합한다.
구질 유사도는 조건별 색인 안에서만 거리를 계산한다. 검증 미달인 거리 기준을 개선된 예측으로
표시하지 않는다. 적용 시 선택 투수의 관측된 정규화 코스 구성을 명시하고 타자의 실제 코스를
예측했다고 해석하지 않는다. 미채택 대상과 훈련 20개·5경기 미만 타자는 확률을 비워 둔다.

VAA/HAA는 원천 속도·가속도를 중간면 17/24ft에서 평가한 도 단위 각도다. 초기 방향 정렬이나
구장 보정으로 변환한 궤적을 사용하지 않는다. 대상 투수의 완료 경기만 조회하며 구종·등판별
표본과 도착 위치를 함께 표시한다. 기존 보정 좌표·기준 파일·sealed fact는 바꾸지 않는다.

A04/A08은 실제 투구와 종결 PA를 분리하고 원천 판정면의 코스를 사용한다. A05는 경기일 이전
관측만 비교하며 A06은 필터 전에 연속 투구를 연결한다. A09는 직접/유사 표본을 합산하지 않고,
A12는 실제 대면과 공식 BF·물리적 승계주자를 구분한다. A13의 복합 플레이 가치를 개인 주자에게
전부 배분하지 않는다. 서버는 각각의 repository/route를 조립하고 공통 규칙은 scope·원천
hash·원천 코스·atomic play 조회·제한된 worker와 artifact I/O에만 둔다.

A10/A11/A14 학습은 고정 snapshot을 읽고 연결을 반환한 뒤 별도 maintenance worker에서 실행한다.
시간 분할에서 전처리도 과거 자료만 적합한다. 결과는 기능별 strict schema와 manifest를 가진
hash 파일로 원자적으로 공개한다. 잘못된/손상된 모델, 원천 변경, 학습 기간 안의 적용, 규정/시설
미지원은 새 예측으로 표시하지 않는다. API는 준비된 모델을 적용하고 전체 후보 학습을 시작하지 않는다.
상세 모델 정책과 선택적 날씨 제외는 `docs/analysis/features/`의 기능별 문서가 정의한다.

2025 승리확률은 과거 정상 종료 경기의 학습 입력을 최대 11회 기준으로 재구성한다. 12회에
진입한 경기는 관측된 11회말 3아웃 동점에서 학습용 무승부로 종료하며 이후 상태를 제외한다.
원본 최종 결과와 typed fact는 보존한다. 같은 종료 기준으로 2023/2024 후보를 비교하고 2025를
평가한다. 새 정책 `regular-2022-2025-shortened-limit-v1`로 재학습하며 이전 파일을 대체 적용하지 않는다.

궤적과 매치업의 비교 조건은 필요한 투구·연결 트래킹만 읽고 경기별로 조인 범위를 제한한다.
투수 변화는 저장된 보정·포심 기준을 먼저 확인한 뒤 대상 투수만 조회한다. 완료 경기 전용 기준의
키를 구분한다. 품질 재조회는 current revision·분류·유효 신장을 같은 snapshot에서 검증한 뒤
용량 제한 캐시를 사용하므로 신장 보충도 존 집계를 무효화한다.

`0011_game_competition`은 공식 일정의 불변 evidence dataset과 시즌 current 포인터를
`reference` schema에 추가한다. `current_analysis_games`는 current sealed revision에 확인된
경기 종류를 연결하며 연결되지 않은 경기는 `unknown`이다. 경기 facts를 수정하지 않는다.
`0012_competition_game_links`는 KBO/Naver의 서로 다른 원본 경기 ID 연결을 별도 불변 관계로 보존한다.
제공자 형식 해석은 collection에 두고 날짜·팀 코드·더블헤더 순번이 유일한 경우만 연결한다.
`analysis:validate`는 읽기 전용 운영 snapshot을 고유 검증 DB에 복사해 공식 분류·순차 학습·
조회 실행계획을 재현한다. 운영 workspace와 paired backup을 대체하거나 운영 모델을 공개하지 않는다.
`/analysis/coverage`는 투구/PA를 각 grain에서 먼저 집계하고 같은 궤적 계산으로 eligibility를 확인한다.
`/analysis/statistics`는 player-game 사실을 합산하며 팀별 당시 소속을 유지한다. ER가 빠진 경기의
아웃 수를 확인 경기 ERA의 분모에 섞지 않는다. 상세 계약은 [분석 설계](docs/analysis/design.md)와
[진행 상태](docs/analysis/implementation-status.md)를 따른다.

current view는 `current_pitches`, `current_plate_appearances`, `current_batted_balls`, `current_plays`,
`current_runner_movements`, `current_player_game_*`, `current_player_season_*`를 제공한다.
`all_revision_*`는 기록정정 전후 비교용이다.

투구 view는 실제/비실제, PA·선수·count·out·base·score 문맥, call과 strike/swing/whiff/CSW/in-play,
wide tracking을 함께 제공한다. raw player/team ID와 source identity, 현재 canonical ID를 함께 노출한다.
season view는 비율과 함께 numerator·denominator를 노출한다. denominator가 0이거나 measurement
profile이 zone을 지원하지 않거나 필요한 위치가 없으면 값은 `NULL`이다.

strike zone formula version 3은 공 중심 기준 다음과 같다. `cross_plate_y`는 플레이트의 종방향 위치다.
`y(t)=cross_plate_y`의 첫 비음수 교차 시각을 구하고 같은 시각의 `z(t)`를 높이로 사용한다.

```text
abs(cross_plate_x) <= (47.18/2/30.48) ft
and z(t) between (height_cm * bottom_ratio / 30.48) and (height_cm * top_ratio / 30.48)

y(t) = y0 + vy0*t + ay*t*t/2
z(t) = z0 + vz0*t + az*t*t/2
```

`0005_tracking_plate_height`는 SQL view의 계산만 재생과 맞춘다. 원천값·sealed revision·projection hash와
analytics/projection `4/4`는 유지한다. 필요한 궤적값 누락, 비정상 값, 비음수 교차 시각 부재, 음수 높이,
잘못된 존 경계에서는 zone/chase를 `NULL`로 남기고 비율 분모에서 제외한다. SQL과 재생은 같은 좌표
회귀 사례로 검증한다.
`0006_tracking_zone_parallel_safety`는 EXCEPTION 블록의 subtransaction이 병렬 집계와 충돌하지 않도록
SQL 함수를 `PARALLEL UNSAFE`로 지정한다. 10,000개 궤적과 병렬 실행 활성화 설정으로 회귀 검증한다.

공식 ER처럼 compiler가 독립 계산하지 못한 값은 `official_*` 이름으로 구분한다. 2024 규모에는
partition을 사용하지 않고 season/date/player/pitcher/batter/count/result 중심 index를 둔다.

## 10. API, Web, SQL 접속과 replay

`/analysis/models`와 `/api/v2/analysis/models`, `/api/v2/analysis/model-jobs`,
`/api/v2/analysis/model-policy`는 적용 시즌별 여섯 모델의 상태·갱신·취소·선택적 자동 갱신을 제공한다.
2020–2025를 조회하며 일반 모델은 2023–2025, 승리확률은 2025만 학습한다. 적용 시즌 직전 두
시즌으로 검증하고 각 검증 시즌 이전 자료만 적합에 사용한다. 이력 부족은 명시적으로 제외한다.
작업/설정은 시즌을 포함하는 version 2이고 기존 strict legacy 파일은 당시 고정 범위인 2025로 읽는다.
모델 파일과 봉인 DB 계약은 유지한다. 학습·검증·적용 기간이 맞지 않는 파일은 적용하지 않는다.
하나의 작업이 정해진 의존 순서로 전용 worker를 실행하며 worker 안에서 DB 입력을 읽고 학습한다.
부모의 기존 workspace writer가 원천 재확인 뒤 기존 모델별 검증기로 공개한다. GET은 학습하지 않는다.
작업 UUID와 단조 증가 sequence를 atomic 파일로 저장하고 재시작 시 미완료 작업을 중단 처리한다.
신장 manifest hash는 같은 snapshot의 revision·sealed 신장 dataset·고정 신장 선택 지문이 같을 때만
재사용한다. 분류와 dataset은 매 요청 검증하며 기존 source/model/response hash 정의를 유지한다.
세부 책임과 운영 절차는 [모델 운영 설계](docs/analysis/model-management.md)를 따른다.

투수 운용 조건 비교는 `/api/v2/analysis/pitcher-workload/:pitcherId/comparison`의 별도 strict DTO다.
기존 등판 조회는 유지한다. 같은 투수·시즌의 역할/구종/타석/카운트 공통 셀을 지표별 분모로
표준화하며 휴식·이전 3/7일 투구·경기 내 순번·동일 타자 대면별 차이를 제공한다. DB는 narrow
fact를 셀로 집계하고 연결을 반환한 뒤 기존 분석 worker에서 경기 단위 bootstrap을 수행한다.
현재 경기 선택/이력 조회와 날짜 창만 두 소비자가 공유한다. 새 DB/model 계약이나 migration은 없다.
웹은 패널을 열 때 요청하며 표본·미상 제외·불확실성·관측 비교의 한계를 표시한다.
계산 기준은 [투수 운용](docs/analysis/features/12-pitcher-workload.md)에 고정한다.

분석 회귀 점검은 `analysis:audit --run <검증 실행>`으로 기존 격리 DB·읽기 전용 연결을 재사용한다.
전체 선수·시즌의 운용 비교는 독립 투구 합계·제외·분모·순서 반전 결과를 대조하고, 품질·구종 기대
효과·운용은 실제 route/worker의 순차·동시 HTTP 조회와 취소 후 복구를 측정한다. 매번 새 결과
디렉터리에 기록하고 원천·모델·응답 hash 차이를 구분한다. 검증 로직은 scripts에 두며 production
계산기·별도 서비스·모델 registry를 추가하지 않는다. 상세 범위는 [검증 절차](docs/analysis/real-data-validation.md)를 따른다.

`/analysis/batter-discipline`는 타자별 실제 코스 스윙 지도와 평균 포심 가정의 도착 위치·시간 대비
스윙률을 제공한다. 초기 위치·방향을 보존한 각자의 플레이트 도착 위치를 비교하며 기존 동일 시각
투구 움직임 좌표와 구분한다. 실제/가정 존 전이와 카운트·구종·타석·구속대·코스별 다른 타자 비교,
비교 가능 분모와 개별 투구를 표시한다. 순수 game-core 계산은 DB 연결 반환 후 전용 worker에서
수행하고 시즌/hash가 같은 준비된 표본을 재사용한다. 계약·제외 기준·가설의 한계는
[타자 선구안 분석](docs/batter-discipline-analysis.md)을 따른다. DB migration/봉인 fact는 변경하지 않는다.
`courseComparison`은 기존 SQL 존 판정 가능 표본과 포심 비교 가능 공통 표본의 기본 코스 지표를
구분한다. 같은 공통 타자 투구에 대해 실제 코스·카운트·구종·타석·구속대만 맞춘 리그와,
포심 예상 존 조건을 추가한 리그를 나란히 반환한다. 두 비교 모두 조건별 다른 타자 20구 이상일 때만
사용하며 분모·대상 리그의 기본 풀을 고정한다. 상단 Chase%는 기존 SQL 코스 표본 기준이며,
지도는 좌표를 계산할 수 있는 표본을 유지한다. 모델 버전 1과 기존 궤적·존 판정 정의는 유지한다.

모든 endpoint는 `/api/v2` strict DTO를 사용하고 system/catalog/collection/correction/import/revision/
replay route 경계를 유지한다. Database 화면은 revision history와 current를 표시하고 reopen과 명시적
재수집을 제공한다. correction 화면은 candidate source 위치·ID·PA·ordinal·metric 차이와 연결 가능한
pitch를 나란히 보여준다. Replay는 current/과거 revision을 선택하며 pitch마다 최대 한 tracking만
표시한다.

`GET /api/v2/games`의 catalog item은 authority 기반 strict union이다. ready/quarantine workspace와
database 항목은 경기일·대진을 제공하고 source failure는 관찰되지 않은 요약을 만들지 않는다.
workspace 표시 요약은 startup의 기존 무결성 검증 후 메모리에 구축하고 반복 조회에서 재사용한다.
current 전환의 성공·실패 뒤 해당 경기만 무효화하며 동시 조회의 갱신을 공유하고 파일 읽기는 최대
16개로 제한한다. 갱신 도중 저장된 새 상태를 이전 읽기 결과로 덮지 않는다. 인덱스는 재구축 가능한
표시용이며 원장 읽기·writer token·교정 hash·DB import의 파일/컴파일 검증을 대신하지 않는다.
workspace 항목은 파일 상태를,
database 항목은 relational fact에서 집계한 `gameDate`, `teams`, `currentRevision`, `revisionCount`를
필수로 가진다. Database는 이 요약만으로 목록을 그리고 선택한 경기의 revision 상세만 한 번 조회한다.
route page는 lazy chunk로 로드하며 기록정정·Database는 공통 운영 콘솔 shell과 선택 가능한 고정
높이 virtual list를 사용한다. 상단에는 상태와 핵심 명령, 왼쪽에는 검색·범위 목록, 오른쪽에는 선택
상세와 sticky action bar를 둔다. 900px 이하에서는 DOM의 목록 상태와 scroll을 유지한 채 목록과
상세 중 하나만 표시한다. 검색어 변경은 URL history를 replace하고 범위·항목 선택은 history entry를
추가한다. 기록정정 목록은 경량 DTO를 사용하고 원문·후보·통계 변경은 단건 endpoint에서만 읽는다.

분석 사이드 메뉴는 `선수 분석`, `리그·경기`, `분석 관리`로 구성하고 내부 스크롤을 제공한다.
`/analysis/players`와 `/analysis`는 시즌·선수 유형·이름/ID로 선수를 찾는 목록이다. 투수를 선택하면
코스·결정구를 열고 기본 기록, 구질·움직임, 최근 변화, 배합·궤적, 등판·운용, 매치업으로 이어진다. 타자는
반응·성적에서 기본 기록, 선구안과 매치업으로 이동한다. 선수·팀 성적, 주루, 구장 환경, 재생은 리그·경기에,
자료 품질과 모델 관리는 분석 관리에 둔다. 개별 분석 주소는 계속 직접 접근할 수 있으며 사이드
메뉴에 없는 상세 주소도 작업 영역 전환 시 query와 hash까지 복원한다.

선수별 항목 링크는 `pitcher` 또는 `batter`, `season`, 실효 `competition`, `dateFrom`/`dateTo`를
전달한다. 매치업과 기본 기록에는 `playerRole`로 탐색 중인 주선수를 표시한다. 다른 기능으로 이동할 때 군집·
차트·카운트 등 기능 고유 조건을 전달하지 않으며 뒤로 가면 원래 URL이 복원된다. `선수 변경`은
같은 유형·시즌·경기 범위의 선수 목록으로 돌아간다. 새 목록은 regular가 기본이고, 기존 구질·선구안
deep link의 all 기본값과 투수 변화의 기본 종료일인 시즌 12월 31일은 유지한다.

기본 기록은 기존 성적 API의 선택적 `playerId`를 사용해 SQL 집계 전에 선수를 제한한다.
선수 조건과 팀 합계의 동시 요청은 400이며, 응답의 query·범위·선수 ID를 웹에서 검증한다.
이적 당시 팀별 행, 공식 PA/BF, 정수 아웃 수와 ER 확인 범위를 유지한다. 공통 범위의 빈
`competition=`은 유효하지 않은 입력으로 거부해 선수 목록과 성적의 기본 경기 종류가 달라지지
않도록 한다. [기본 기록 구현](docs/reviews/2026-09-23-basic-records.md)을 따른다.

선수 탐색은 기존 투수/타자 catalog의 이름·ID·실제 투구 수를 사용한다. 현재 범위의 실제 투구 기록이
있는 선수만 목록화하며 정규 등록 명단으로 확대 해석하지 않는다. 선택한 유형만 조회하고 이름/ID
검색·페이지 이동은 받은 목록에서 수행한다. 페이지당 최대 48명만 DOM에 표시하며 검색어 `q`는
history replace로 갱신한다. 공통 `PlayerAnalysisFrame`은 같은 catalog query identity를 비활성
observer로 관찰하므로 추가 목록 요청이나 다른 분석의 선행 계산을 만들지 않는다. 기존 페이지가
query·선수 결정·입력 검증을 계속 소유한다. 탐색 모듈은 기존 기본값을 읽어 링크에 명시한다.

`PitcherScopeFields`는 `AnalysisFilterBar`를 사용해 시즌·투수를 기본 조건에, 경기 범위와 배합 등
부가 필터를 native details의 세부 조건에 배치한다. 매치업의 타자는 `primary` 슬롯으로 기본 조건에
유지한다. 접힌 범위 요약은 현재 URL을 반영하며 상태 변경과 계산은 각 페이지가 담당한다.
[선수 중심 탐색 기록](docs/reviews/2026-09-22-player-centered-navigation.md)에 경계와 검증을 정리했다.

본문 건너뛰기, 모바일 메뉴 닫기와 포커스 복귀, 목록의 단일 키보드 진입, 실제 탭의 방향키 이동은
공통 UI 컴포넌트가 소유한다. 분석의 비활성 query는 로딩으로 표시하지 않고, 관련 화면 링크는
기간·경기 종류를 유지한다. 대시보드는
실제 화면으로 연결하며 기록정정 조회 실패를 0건으로 표시하지 않는다.
[UI 점검 기록](docs/reviews/2026-09-22-frontend-ui.md)에 변경 범위와 검증 결과를 정리했다.

분석 작업 영역의 시각 규칙은 scoped stylesheet로 관리한다. 코스·결정구/타자 반응 화면은 API의
집계를 핵심 지표로 표시하고, 위치 지도·선택 코스 요약·상황별 비교·근거 기록을 분리한다.
공통 `AnalysisFilterBar`는 기본 입력과 native details의 세부 입력을 배치하며 조건 상태는 각
화면의 URL이 계속 소유한다. 접힌 상태에도 적용 범위를 표시한다. 비교 전환과 상세 열 표시는
이미 받은 응답의 표현이며 추가 요청이나 별도 통계 계산을 만들지 않는다. 지도의 소표본 표시와
기록별 revision-bound 재생 링크를 유지한다. [설계 기록](docs/reviews/2026-09-22-analysis-design.md).

선수 리포트 머리글의 catalog 투구 수는 시즌·경기 종류·기간 범위이며, 개별 구종·타석·카운트 조건을
적용한 결과 표본과 구분한다. 빠른 상황 조건은 URL의 관련 키를 한 번에 갱신한다. 2스트라이크는
볼 조건을 제거하며 초기화는 `pitchType`·`stance`·`balls`·`strikes`·`cohort`만 지우고 선수와 공통
조회 범위를 유지한다. 비교 표는 응답의 숫자값으로 정렬하고 null은 양방향 모두 마지막에 두며
동률은 원래 순서를 유지한다. 상세 열을 숨길 때 그 열의 정렬은 해제한다. 분모 설명은 native
details로 제공하며 1,500px 이상에서는 비교 표와 지도를 두 열로 표시한다. API·모델·외부 자료는
추가하지 않았다. [참고 사이트와 구현 경계](docs/reviews/2026-09-23-reference-analytics-ux.md).

수집은 `수집 현황`/`수집 기록` 탭과 월→일→경기 탐색을 사용한다. URL 상태, 마지막 로컬 탐색 상태,
한국 시간 오늘 순서로 범위를 복원하고, 입력 중 외부 요청 없이 명시적 경기 확인으로 schedule-only
background discovery를 생성한다. 저장된 조회와 시각을 먼저 표시하고 새로 확인·취소를 제공한다.
일정, workspace current 표시 요약과 DB typed catalog를 서버에서 중복 제거해 결합하며 원장 read나
compile을 하지 않는다. 작업본이 대표 저장 상태이고 DB 저장 여부는 따로 표시한다. 실제 날짜가 없는
원천 실패는 별도 목록이며, 불완전 일정의 미수집 수는 `null`/`—`다.

탐색·검색·표시 필터와 실행 기간·조건·선택은 독립적이다. 기본 대상은 미수집, 원천 실패는 별도
재시도다. 서버가 조건과 포함/제외 ID를 검증한 뒤 선택 ID와 최대 50,000경기 집합을 불변 저장한다.
collection job scope에 `selection`을 추가하되 기존 `date_range`/`game_ids` 경로는 유지한다. 시작과
저장 경계의 workspace token·DB base가 달라지면 건너뛴다. 수집 저장과 import는 경기별 operation gate를
공유하고 current 파일 교체는 기존 writer lock·CAS·journal을 사용한다. DB migration은 추가하지 않는다.

`/api/v2/collection-discoveries`, `/:id/overview`, `/:id/games`, `/collection-selections`,
`/collection-history`, `/:id`, `/:id/games`는 strict TypeBox DTO를 제공한다. 경기/이력 페이지는 기본
50건·최대 200건이다. Query key에 범위·조회 ID·필터·페이지를 포함하고 AbortSignal을 전달한다.
경기 상세는 선택 시만 열며 1100px 이하에서는 목록 대신 표시한다. 화면 문구는 저장 상태·검증 결과를
사용하고 경기 ID·revision은 기술 정보에 둔다.

일정 원문·정규화 결과·확정 선택·작업 요약·경기별 결과는 `.data/collection`에 hash envelope로 보존한다.
queued 요청과 idempotency를 생성 응답 전에 저장하고 SSE 순서는 snapshot 저장 뒤 공개한다. 중단된
작업은 완료 경기 결과를 유지하며 자동 재개하지 않는다. 원래 요청 키는 재시작 후에도 같은 작업을
반환한다. 수집 당시 결과와 현재 상태를 구분하고 이미 사라진 완료 이력은 복원하지 않는다.

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

공지의 경기 연결은 날짜·원정/홈 팀을 기준으로 current sealed revision에서 찾는다. 구장명은
연결 조건이 아니며 표기 차이나 미제공을 허용한다. 복수 대진은 DH 번호로 구분하고, 명시된 DH
번호는 단일 후보에도 검증한다. 미연결 공지는 `경기 연결 필요`로 표시하고 해당 경기 적재 후 다시
평가한다. 날짜·팀·DH가 확정된 뒤 정정할 타석의 이닝·초말·타순·타자·투수 일치는 별도로 검증한다.

자료 품질 GET은 fresh 원천 키로 저장 요약을 검증하고 미준비 시 202 상태를 반환한다.
동일 시즌·경기 종류의 준비는 한 작업으로 병합하고 동시 1개/대기 16개로 제한한다. 경기별 요약을
writer lock·원자 쓰기로 저장하여 기간 변경과 재시작에 재사용한다. revision·분류·유효 신장·보정
파라미터·정의 버전이 달라지면 새 요약을 준비하며 실패는 명시적인 재시도로 복구한다.
완료 품질 응답의 값·hash·분모는 유지한다. [계약과 검증](docs/analysis/2026-09-21-coverage-preparation.md)을 따른다.

## 11. 검증과 초기화

분석의 읽기 전용 snapshot 수명은 persistence 내부 공통 helper가 소유하고 각 repository가
SQL·grain·hash를 소유한다. 모델 manifest·의미 검증·파일 공개, 구질 fitting·평가·학습·조회는
각 책임으로 나눈다. 서버는 계산 protocol·호출 어댑터·worker 실행기를 구분하며, 웹의 동일 범위
선수 목록은 같은 query identity를 사용한다. [모듈 경계 점검](docs/reviews/2026-09-22-modularity-refactor.md)에
구체적인 소유권과 유지한 불변식을 설명했다.

DB 적재 transaction과 seal은 `GameRevisionStore`가 소유한다. manifest 검증, typed relay decode,
원장 hydration, 저장 fact의 replay 변환은 별도 내부 모듈이며 replay 변환은 전체 원장 hydration이나
compiler를 실행하지 않는다. `StagingWorkspace`는 writer lock·경기별 직렬화·catalog 무효화를,
`WorkspaceCurrentStore`는 검증 callback과 함께 current CAS·journal·archive·복구를 소유한다.
보정 session store는 용량·유휴 회수·mutex·version 검사를 맡고 manager는 컴파일·history·commit을
조정한다. 공개 API·저장 형식·projection hash 계약은 유지한다.
[분리 경계와 검증](docs/reviews/2026-09-23-persistence-boundaries.md).

대량 데이터 경로는 검증된 read 결과만 제한적으로 재사용한다. current manifest와 결합된 적재 대상
식별 정보, 수집 이력 32MiB/16작업, 원문 32MiB/8bundle/미사용 5분, replay 64MiB/16bundle/미사용
60초를 사용한다. 새 replay manifest와 실제 import는 전체 무결성을 다시 검사한다. 교정 응답은
동일 version에서만 재사용하고 매 응답 복제하며, 모든 명령 뒤 전체 컴파일과 CAS는 유지한다.
세션 정리·미저장 사본 복귀는 `docs/correction.md`, worker 시작 검증과 준비 중 503 계약은
`docs/collection-and-staging.md`를 따른다. DB 목록은 SQL 페이지, fact 저장은 parameter 제한을 둔
다중 행 INSERT로 처리하며 기존 transaction과 seal 검증을 유지한다.

2025 시즌 검토 후 DB 화면은 `/database/games`와 `/import-history` 서버 페이지(기본 50, 최대 200)를
사용한다. 필터에서 제외된 상세를 해제하며 실행 선택은 탐색과 독립적이다. `/import-selections`는
문서 hash와 revision base 집합을 확정하고 batch는 선택 ID를 제출한다. 시작 시 달라진 문서는 건너뛴다.
`.data/imports`에 batch 의도와 경기별 결과·요청 키를 응답 전에 저장한다. 재시작 시 DB manifest를
대조하고 미완료 작업을 자동 실행하지 않는다. DB 저장 성공과 후속 파일 정리 필요를 구분한다.

보정 UI는 날짜·대진·기간 탐색, 동일 종류 검증의 접기, 최초 미적용 차단 행 이동, 명령 전후 해소/신규
차단 수, 요약 원문과 전체 JSON 접기, 저장한 문서의 단건 적재 및 다음 검토 경기 이동을 제공한다.
화면 그룹은 인과관계를 추정하지 않는다. 모든 변경은 기존 structured command/undo/redo 경로다.

`administrative.called_game`은 명시적 연장 콜드 종료를 표현한다. 마지막 반이닝·최종 상태·후속 진행
부재를 compiler가 검증한다. 야수선택 책임은 주자별 최종 이동으로 배정한다. 같은 베이스에 남은
생존 주자도 포함하며 이동 검증 성공 뒤 최종 점유에 반영한다. 같은 베이스로의 안전 도착 뒤 진루·득점은
연속 경로로 검증하고, 실제 중복 출발은 차단한다. 명시적 콜드 종료 뒤 실제 투구·결과·주자 이동 없이 남은
이닝·타자·교체 표시는 원문을 가진 안내 행으로 보존한다. 쓰리번트 terminal pitch의
관찰 strike=2는 확인된 삼진일 때만 warning으로 남긴다. projection/analytics 4/4와 기존 migration은 유지한다.

preview 누락 로스터는 중계 해석 전에 같은 경기 record 박스스코어의 명시적 ID·이름·팀으로 보완한다.
기존 선수 정보를 유지하고 추가 선수의 선발·타순을 추정하지 않는다. 투수 참가만 포지션 근거로 쓰며,
ID·이름·팀 또는 별칭 충돌은 blocking이다. 보완 warning에는 record 배열 경로와 행 위치를 보존한다.
원본 source bundle은 불변이며 보완 후 전체 strict compile을 거친다. 기존 수집 데이터의 명시적 적용은
writer lock·current token 검증·versioned transition 경로를 사용하고 수동 교정본과 sealed DB는 보존한다.

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
