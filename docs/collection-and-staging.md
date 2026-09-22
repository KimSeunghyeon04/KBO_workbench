# 수집과 staging 운영

스트라이크존은 타자 키로 계산한다. 2024년까지는 2024 규칙, 2025·2026년은 2025 규칙을 사용하며
트래킹 존으로 대체하지 않는다. 키가 없으면 계산 불가다. [정책·구현·검증](strike-zone.md)을 따른다.
선수 키는 `extractNaverPlayerHeights`가 원문의 선발·후보·중계 선수 명단과
`textRelays[].textOptions[].batterRecord/pitcherRecord`에서 선수 ID별로 추출한다.
원장을 다시 쓰지 않고 가져오기 시 원문 해시·출처와 함께 DB에 저장한다. 기존 DB 경기도 같은
추출기로 원문을 검증해 보충한다. 추출 버전 2를 별도로 봉인해 기존 버전 1 관측과 해시를 보존한다.
같은 시즌 자료·검토한 공식 프로필에 의한 보완과 채택값 고정은 persistence의 책임이다.

수집 이력 목록은 검증한 정렬 결과를 최대 32MiB/20,000건까지 재사용하고 요청한 페이지의 사본만
반환한다. writer 저장 성공은 해당 기록을 갱신하며 겹친 쓰기·실패는 캐시를 무효화한다. 한도를
넘으면 검증된 파일 읽기를 계속 사용하고 이력을 지우지 않는다. 재시작 시 hash/decode를 다시
수행한다. 이력 상세는 현재 페이지의 경기 ID로 workspace·DB 요약을 조회한다.

정규화와 mapping 후 전체 compile은 보정·적재와 공유하는 최대 2개 CPU worker에서 실행한다.
원천 bundle 보존, 경기별 잠금, current token 재확인과 원자 저장은 기존 writer가 수행한다.
취소 signal을 계산 대기·실행에 전달하며 취소된 계산 결과를 현재 원장에 반영하지 않는다.

## 목적과 경계

수집 결과인 `StagingGameDocumentV2`는 최종 경기 상태가 아니라 Naver 중계를 정리·보정하는
strict 평면 원장이다. `schemaVersion`은 `2`이며 V1 경기 문서와 호환하지 않는다.

상위에는 source·revisionBase·metadata·팀·roster·trackingCandidates·공식 기록을 두고 `events`에는
다음 행만 둔다.

- `half_inning_start`
- `batter_start`
- `pitch`
- `plate_result`
- `runner_advance`
- `substitution`
- `review`
- `administrative`
- `unresolved`

아웃·베이스·점수·PA·계산 기록과 DB play는 JSON에 저장하지 않는다. 수집과 모든 보정 명령 뒤
`compileStagingGameDocumentV2`가 전체 원장을 다시 계산한다.

## 수집 흐름

수집 이력의 경기 결과는 hash 검증 후 최대 32MiB·16개 작업의 메모리 목록으로 재사용한다. 결과가
추가되는 전후에 해당 목록을 무효화하고, 읽기 중 쓰기가 겹치면 완료된 세대로 다시 읽는다. 동시
목록 요청은 같은 읽기를 공유하며 API 필터·정렬·페이지 계약은 유지한다.

workspace 시작 시 journal 복구 뒤 모든 current 원장·finding·hash를 검사한다. 64경기 이상은
최대 4개 worker가 같은 검증 모듈로 나누어 처리하며 잘못된 자료가 있으면 준비 상태로 전환하지 않는다.
시작 중 HTTP liveness는 응답하고 readiness와 업무 API는 503으로 차단한다. 웹 조회는
`server_initializing`에만 2초 간격으로 최대 5분 재시도하며 mutation은 자동 재시도하지 않는다.

적재 대상 확정은 검증된 revision/hash 메타데이터를 현재 manifest 전체와 대조하고, manifest가
바뀌었으면 원장과 finding을 다시 검증한다. 이 메모리 정보는 적재할 문서를 대체하지 않으며 실제
import 직전에는 원장 읽기·전체 컴파일·hash와 expected target 일치를 다시 확인한다.

투구 payload는 선택적인 `speedKph`(유한 양수)와 `pitchType`(제공 구종명)을 가진다. collection은
`textOptions` 투구 행의 `speed`와 `stuff`를 해석하며 `ptsOptions`, tracking 좌표와 pitch ID 유무에
의존하지 않는다. 빈 값은 속성을 생략하고, 잘못된 값은 endpoint/block/row/event ID와 원문을 포함한
`source.pitch_metadata.invalid_speed` 또는 `invalid_stuff` warning을 남긴다. 구종 재분류는 하지 않는다.

1. `경기 확인`이 격리된 Playwright context에서 완료·미취소 일정만 탐색한다. 저장된 조회가 있으면
   먼저 표시하고 명시적 새로 확인으로 갱신한다. 원문 page와 정규화 결과는 hash와 함께 보존한다.
2. 서버가 실행 대상 기간·미수집/원천 실패 조건·개별 선택/제외를 검증하고 경기 집합을 확정한다.
   기본 미수집 수집은 staging/quarantine/DB/원천 실패를 제외한다. 실패 재시도는 별도 조건이다.
   기존 명시적 `game_ids` 재수집에서는 staging을 건너뛰고 quarantine 재수집을 허용한다. 각 건너뜀도
   경기별 결과와 진행 이벤트에 남긴다. 모든 경로에서 시작과 저장 경계의 작업본 token·DB base를 확인한다.
3. HTTP adapter가 preview, relay summary, 이닝별 relay와 record를 가져온다.
4. endpoint payload를 canonical JSON gzip과 manifest로 `.data/source`에 불변 저장한다. source
   경로의 season은 경기 ID 접두사가 아니라 preview의 실제 경기 날짜에서 정한다.
5. normalizer가 `textRelays[]` 배열 위치가 아니라 provider block `no`를 기준으로 원천 순서를
   복원하고 반복·정정 suffix를 포함한 모든 의미 행을 원천 위치별로 방출한다.
6. mapper가 원천 행마다 결정적 event ID와 정확한 endpoint·block·행 위치를 부여한다.
7. compiler가 strict 참조, 선수·타석 경계, 원자적 play, tracking, 상태·PA·기록과 원천 관측을
   검증한다.
8. 차단 finding이 없으면 staging, 있으면 quarantine으로 저장한다.

종료 경기의 명시적 `called_game` 선언 뒤 이닝·타자·교체 표시만 남고 이후 투구·타석 결과·주자 이동이
없으면 그 표시들을 원문·identity·소스 위치가 있는 안내 행으로 보존한다. 실제 진행 행이나 미해결 종류가
뒤따르면 이 예외를 적용하지 않는다. 단순 종료 footer만으로 교체·반이닝 경계를 무효화하지 않는다.

## 기간 현황과 영속 작업

`CollectionOperationsService`는 일정 entries, workspace current 표시 요약, DB typed catalog를 결합한다.
경기 ID는 한 번만 집계하며 작업본 상태가 우선이고 DB 저장 여부는 별도로 유지한다. 일정에 없는
보유 경기도 실제 경기일이 범위에 들어오면 포함한다. 날짜 미확인 원천 실패는 기간 집계에서 제외한다.
현황·검색·페이지 조회는 전체 원장 read/hydration/compile을 수행하지 않는다.

- `POST/GET /api/v2/collection-discoveries`: 일정 조회 생성과 범위별 저장 조회 목록
- `GET/DELETE /api/v2/collection-discoveries/:id`: 진행 조회·취소
- `GET /api/v2/collection-discoveries/:id/overview`: 월/일 집계 (`startDate`, `endDate`, `groupBy`)
- `GET /api/v2/collection-discoveries/:id/games`: 범위·팀/날짜/ID 검색·상태·페이지 (`search`, `state`,
  `unknownDate`, `page`, `limit`); 기본 50건, 최대 200건
- `POST /api/v2/collection-selections`: `all_matching` 또는 `explicit`, 포함/제외 ID로 선택 확정
- `POST /api/v2/collection-jobs`: 기존 scope와 `{kind:"selection",selectionId}` 지원
- `GET /api/v2/collection-jobs?activeOnly=true`: 진행 작업 snapshot
- `GET /api/v2/collection-history`, `/:id`, `/:id/games`: 보존된 작업과 경기 결과 페이지;
  `problemsOnly=true`는 검토 필요·원천 실패·중단 결과

모든 새 DTO는 contracts의 strict TypeBox 계약이다. 경기 문서·DB projection·migration 버전은 바꾸지 않는다.
일정 page 일부가 실패하면 부분 entries와 원문은 남기지만 `complete=false`, 미수집 수는 `null`이다.
확정 선택에는 당시 작업본 token과 DB revision을 저장한다. 이후 상태 변경은 대상 추가 없이 건너뛴다.
수집 저장과 DB 적재는 동일 경기의 workspace operation gate를 공유하며, 실제 current 교체는 기존
writer lock·current CAS·journal 경로를 사용한다. 네트워크 요청 중에는 이 gate를 점유하지 않는다.

```text
.data/collection/
  discoveries/<id>/record.json       # 범위·상태·시각·요청 키
  discoveries/<id>/entries.json      # 정규화된 일정 요약
  discoveries/<id>/page-N.json.gz    # URL·status·원문 page, 불변
  selections/<id>/record.json        # 확정 경기 집합·조건·저장 token, 불변
  jobs/<id>/record.json              # 작업 snapshot·요청 키·마지막 SSE 순서
  jobs/<id>/targets.json             # 실행 대상, 불변
  jobs/<id>/items/<gameId>.json       # 경기별 당시 결과, 불변
  known-games/<gameId>/record.json    # 보유 원천 실패의 날짜·대진 조회용 결과 요약
```

각 파일은 canonical payload와 SHA-256 envelope를 strict decode해 읽는다. 작업 요약과 경기 결과를
분리하므로 매 경기마다 전체 이력을 다시 쓰지 않는다. queued 기록과 idempotency 정보는 생성 응답
전에 원자적으로 저장한다. 이벤트 순서는 영속 snapshot 저장 뒤 공개하고, 재연결은 snapshot 조회로
동기화한다. 재시작 시 queued/running 작업은 완료 결과를 보존한 채 중단 처리하며 자동 재실행하지
않는다. 같은 요청 키는 복구한 원래 작업을 반환한다. 기존 journal에만 남은 중단 snapshot도 보존하되
이미 사라진 과거 완료 이력이나 알 수 없는 경기별 결과는 추정하지 않는다.

## 원장 보존 원칙

- 의미 있는 Naver 중계 행은 typed 행, `administrative`, `review` 또는 `unresolved` 중 하나로 남긴다.
- 원천에 없는 타석 시작·반이닝 종료·투구·결과·주자 이동을 합성하지 않는다.
- 한 행을 해석하지 못하면 원문, sanitized source type, 추정 가능한 kind와 원천 위치를
  `unresolved`에 보존하고 후속 행 처리를 계속한다.
- 공지, 마운드 방문, 휴식, footer, 상태를 바꾸지 않는 판독도 버리지 않는다.
- 광고와 상태 snapshot의 불필요한 필드, 원천 payload 전체는 저장하지 않는다.
- Naver 원문은 `relayText`에 1~1,000자로 trim해 저장한다. 파생 문구를 원문처럼 만들지 않는다.

## 정규화 결정 규칙

중계 해석 전에 preview 로스터를 만들고 같은 경기 record의 타자·투수 박스스코어에서 빠진 선수를
보완한다. 현대·legacy preview와 기존 record 별칭을 지원하며 원본 bundle은 변경하지 않는다.
박스스코어의 명시적 ID·이름과 away/home 소속이 모순 없이 일치해야 한다. 같은 ID의 여러 기록은
한 선수로 합치되 이름만 같은 다른 ID는 합치지 않는다. 반대 팀 roster/record와 ID 별칭 충돌,
추가할 선수의 서로 다른 이름 근거는 `source.roster.identity_conflict` blocking으로 남긴다. 누락 선수의
이름을 확인할 수 없으면 `source.roster.identity_missing` blocking이며 중계 문구에서 가져오지 않는다.

기존 roster의 이름·순서·선발·타순·포지션은 유지하며 박스스코어의 축약 표시 이름으로 다시 식별하지
않는다. 추가 선수는 ID순으로 뒤에 붙이고 `starter=false`,
타순 없음으로 둔다. 투수 박스스코어의 참가 근거만 `투수` 포지션으로 사용하며 타자 기록의 타순·
`교` 같은 위치 표기로 선발이나 수비 위치를 추정하지 않는다. 각 보완 근거는
`source.roster.supplemented_from_record` warning에 record endpoint·배열 경로·행 위치와 함께 남는다.
이후 기존 normalizer와 전체 compiler가 중계·교체·공식 기록을 검증하고 차단이 없을 때만 ready가 된다.
비식별 fixture `missing-roster-boxscore.anonymized.json`은 실제 누락 구원투수 교체와 후보 타자 기록
형태를 축소해 보완·충돌·동명이인·원문 보존·결정론을 검증한다.

`normalizeNaverRelay`는 외부 façade이고 내부 처리는 다음 순서의 순수 단계로 구성한다.

1. alias를 한곳에서 해독해 `CanonicalNaverRow`를 만든다.
2. provider block 순서를 확정하되 revision이나 semantic fingerprint로 원천 행을 제거하지 않는다.
3. 한국어 문구를 lexical fact로만 분석한다. 한국어 정규식은 이 계층 밖에서 사용하지 않는다.
4. 각 후보의 rule ID, 근거와 specificity를 비교해 `matched`, `not_applicable`, `unresolved`를 결정한다.
5. 선수·타석 연결 문맥, 원장에서 추론한 베이스 문맥, 원천 관측 snapshot을 분리해 갱신한다.
6. 원천 행 하나를 typed 원장 행 하나 또는 `unresolved` 하나로 방출한다.

선수 식별의 우선순위는 `명시적 ID → source state ID → 예상 팀 roster의 유일한 정확 이름 →
허용된 active context`다. 행 종류는 `유효한 구조화 종류 → 구체적 문구 → sanitized source type`, 결과
세부 정보는 구체적인 문구가 coarse source 값을 보완하는 순서다. 같은 우선순위와 specificity의 근거가
같은 값을 가리키면 evidence를 합치고, 다른 값을 가리키면 어느 쪽도 임의 선택하지 않는다.

타석 결과 본문에 `실책으로 출루`가 명시되어 있고 구조화 결과가 없거나
`field_out`·`fielder_choice`인 경우에는 결과 문구 후보를 일반 출루 후보와 같은 강도로 평가한다.
기존 specificity로 `땅볼 실책으로 출루`는 `reached_on_error`, 낫아웃 실책 출루는 `strikeout`으로
구분하며 희생번트·희생플라이 우선순위와 구체적인 구조화 결과는 유지한다. 괄호 안 부연만으로 이
우선순위를 올리지 않는다. `tests/fixtures/naver/reached-on-error.anonymized.json`과 relay normalizer
회귀는 포구·송구·번트 실책 문구, coarse 결과, 원문·identity·주자 이동·PA/AB/H 보존을 검증한다.
정규화 수정으로 기존 sealed revision은 변경되지 않는다. 기존 경기에는 현재 원장 교정과 전체 compile,
새 append-only revision 적재 절차를 적용해야 하며 같은 원천 재수집만으로 자동 교정하지 않는다.

동명이인 투수 교체의 나가는 선수는 교체 문구에 직전 활성 투수의 이름이 명시된 경우에만 active
context로 좁힌다. 같은 타격 play의 연속 주자 행은 행별 최종 snapshot에 밀려 출발 주자가 바뀌지
않도록 play 시작 시점의 베이스 identity를 별도로 유지한다.

명시적 ID가 예상 팀 roster와 충돌하거나 동명이인을 한 명으로 좁힐 수 없으면 `unresolved`다. finding
code는 `source.relay.<stage>.<rule>` 형식이고 endpoint·block·row·source event ID·원문을 함께 남긴다.
`unresolved`는 의심되는 종류에 해당하는 문맥만 unknown으로 만든다. 후속 원천 행은 계속 보존하며,
명시적인 반이닝 시작·타석 머리글·선수 ID가 있는 투구에서 영향받은 문맥을 다시 동기화한다.

Naver 관측 주자·아웃·점수는 별도 관측 문맥에만 기록한다. 원장에서 계산한 베이스 문맥이나 compiler
상태를 관측값으로 덮어쓰지 않는다. 따라서 관측 불일치는 finding의 근거가 될 수 있지만 후속 원장의
선수 귀속이나 야구 상태를 강제로 바꾸지는 않는다.

Naver가 실제 사구 투구를 `N구 볼`로 보내고 바로 다음 결과 행에서만 사구를 명시하는 경우가 있다.
같은 반이닝에서 타자·투수가 모순되지 않고, 상태를 바꾸는 다른 행 없이 이어지는 명시적
`hit_by_pitch` 결과가 있을 때만 직전 `ball` 투구 call을 `hit_by_pitch`로 보강한다. 원문,
`sourcePitchId`, 원천 위치와 `observedStateAfter`는 그대로 보존한다. 일반 볼넷이나 선수 문맥이
다른 행에는 이 규칙을 적용하지 않으며, 누락된 투구를 합성하지 않는다.

원천 재전송, 반복 묶음과 정정 suffix도 제거하지 않는다. 의미 있는 Naver relay 행은 각각 안정적인
endpoint/block/row identity를 가진 원장 행이 된다. 반복 행 때문에 타석·카운트·아웃 흐름이 깨지면
원천을 숨기지 않고 compiler의 기존 야구 상태 finding으로 차단한다. `sourcePitchId`는 optional이고
non-unique인 출처 힌트일 뿐 event identity나 일반 dedupe key가 아니다.

tracking은 같은 `sourcePitchId`여도 결정론적 `trackingId`별로 모두 보존한다. `sourcePitchOrdinal`은
Naver `ballcount` 원천값으로 보존하지만 PTS 관측 누락·보크·타석 중 교체 때문에 실제 PA 투구
순번과 다를 수 있다. 같은 endpoint/block와 sourcePitchId 안에서 투구와 tracking의 원천 occurrence
순서가 1:1이면 그 순서로 연결하며 ballcount는 사용하지 않는다. 한 투구에 metric까지 완전히 같은
tracking이 반복되면 첫 source 위치를 linked canonical로, 나머지를 duplicate로 자동 분류한다. 실제
metric 충돌, 투구·tracking 개수 불일치와 대응 투구 부재만 pending과 blocking으로 남긴다.

같은 `sourcePitchId`가 경기 안에서 여러 투구에 나타나면 각 투구에
`source.pitch_id.reused_within_game` warning과 전체 원천 위치를 남긴다. ID 반복 자체는 blocking이
아니다. `sourcePitchOrdinal`과 compiler 실제 투구 순번 차이도
`source.tracking.ordinal_differs_from_actual_pitch` warning이며 분석 순번에는 compiler 값을 사용한다.

같은 반이닝과 머리글에서 `seqno`가 이전 block보다 작게 다시 시작해도 이전 block을 폐기하지 않는다.
이전 행과 정정 suffix의 text·tracking을 모두 원천 위치별로 보존한다. 어느 행이 실제 야구 흐름에
남아야 하는지는 명시적 correction으로 결정한다. 단, 종료 metadata와 종료 안내 뒤의 구간이 동일한
반이닝에서 앞선 유일한 연속 구간과 모든 의미 값·순서가 일치하고 실제 투구 ID까지 제공된 경우는
반복 관찰로 정규화한다. 종료 뒤 투구·결과·반이닝 시작 없는 타자 표시도 별도 안내로 정규화한다.
원문 행을 삭제하지 않고 identity·위치·문구와 warning을 유지한다. tracking 관찰도 보존하며 해당 반복
행 외 연결 대상이 없을 때만 `not_a_pitch`로 제외한다. ID만 같은 행이나 실제 후속 진행은 해당하지 않는다.

교체는 들어오는 선수의 역할/수비 위치를 사용하며 수비 이동의 `shiftPlayer`를 해석한다. 연속 대타의
나가는 선수는 현재 타자와 명시 이름을 함께 확인한다. 주자 행의 이름과 플레이 전체 관찰을 구분하며
동명이인은 같은 플레이의 명시 타자 배치·후속 이동까지 확인하고 여전히 모호하면 unresolved로 남긴다.
포수 피치클락 위반의 명시적 자동 볼은 카운트에 반영하지만 실제 투구 수에는 포함하지 않는다.

## 타석 결과와 주자 이동

`plate_result`에는 다음 원천 사실만 둔다.

- 결과, 타자, 투수
- 선택적 타점
- 결과 행 자체가 직접 기록한 아웃 수
- 기본 결과와 다르게 타자가 살았을 때의 도착 베이스
- 선택적 타구 유형과 번트 여부

`plate_result`에는 movement 배열이 없다. 타구 유형은 `ground_ball`, `fly_ball`, `line_drive`,
`popup`으로 구분하고 번트 여부는 `isBunt`로 별도 보존한다. 수비 위치만으로 타구를 추정하지 않는다.
쓰리번트 아웃은 삼진 결과이므로 `isBunt`나 타구 유형을 붙이지 않는다. 낫아웃은 폭투·포일·실책·
출루가 명시된 경우에만 `batterDestination`을 저장하고, 포수 태그아웃·1루 터치아웃·송구아웃은
일반 삼진 아웃으로 둔다.

모든 기존 베이스 주자의 이동은 별도 `runner_advance` 행이어야 한다. context는 정확히 하나다.

- `plate_result`: `plateResultEventId`로 타석 결과 play에 연결
- `independent`: 도루·견제·폭투·포일·보크·실책 등 독립 사유

연결 행은 배열에서 떨어져 있거나 판독·공지 행 사이에 있어도 링크를 유지한다. 다만 같은 play의
연결 행 사이에는 비상태 행만 허용한다. 다른 투구·교체·독립 이동 같은 상태 변경 행이 끼면 차단
finding을 만든다. 삭제된 결과를 가리키는 링크도 차단한다.

compiler는 결과로 확정되는 타자주자 상태만 파생한다. 예를 들어 범타·삼진은 타자 아웃, 안타·볼넷은
기본 도착 베이스, 홈런은 타자 득점이다. 기존 주자의 강제 진루나 홈런 득점은 원장에 실제
`runner_advance`가 없으면 만들어내지 않는다. 결과의 기본과 다른 타자 생존은
`batterDestination`으로 기록한다.

## Compiler 원칙

타석 결과와 연결된 주자 행은 하나의 원자적 play로 compile한다. 타자 기본 movement와 실제 주자
행을 임시 베이스·아웃 상태에서 모두 검증한 뒤 성공할 때만 한 번 commit한다. 일부 이동만 적용해
상태를 오염시키지 않는다.

compiler는 먼저 원장 링크를 immutable `PlayGroup`으로 색인하고 그 뒤 play 단위로 fold한다.
movement engine의 계약은 `이전 상태 + 전체 이동 → 다음 상태 또는 findings`이며 입력 상태를 변경하지
않는다. Naver 타입·한국어 문구·provider 규칙은 `game-core`에 들어오지 않는다.

투구와 투구 사이에서 연속된 독립 주자 행은 사유가 서로 달라도 하나의 play다. Naver는 같은 live
ball에서 일어난 폭투 진루·추가 진루·태그 아웃·득점을 서로 다른 사유 문구로 나눌 수 있으므로 reason
일치만으로 play 경계를 정하지 않는다. 모든 원래 베이스를 임시 상태로 비운 뒤 같은 주자의 다단계
경로는 임시 위치에서 이어서 검증하고 최종 베이스·아웃·득점을 한 번에 반영한다.

- `unresolved`, dangling link, roster 밖 선수, 잘못된 타석 경계는 차단한다.
- 원천 관측 balls·strikes·outs·bases·score는 계산값을 덮어쓰지 않고 원천 행 시점에 맞춰 비교한다.
  투구 snapshot은 다음 플레이 상태가 먼저 반영되는 사례가 있어 count만 비교한다. 타석 결과의 count는
  결과 전 마지막 count이므로 PA 종료 뒤 0-0과 비교하지 않는다. 연결 주자 행이 있는 원자적 play와
  독립 다중 주자 play는 마지막 관측 주자 행을 최종 play 상태와 비교한다. 반이닝·타석 머리글,
  교체·판독·공지 같은 비상태 행은 동기화 지점으로 사용하지 않으며, 같은 불일치가 이어지는 동안에는
  최초 finding 하나만 유지한다. 동기화 여부는 필드별로 관리하므로 투구의 count가 일치해도 앞서
  발생한 score·outs·bases 불일치를 해소한 것으로 보지 않는다.
- 다음 반이닝 시작 시 계산 아웃이 3이면 열린 타석은 `third_out` partial PA로 종료한다.
- 계산 아웃이 3 미만이면 `source_half_incomplete`로 차단하고 다음 반이닝은 독립 계산한다.
- 종료 결과가 없는 partial을 임의의 PA 결과로 완성하지 않는다.
- 제공된 공식 기록만 계산 기록과 비교한다. 득점 play에 명시적 `creditedRbi`가 없으면 기록원의
  타점 판단을 재구성할 수 없으므로 공식 타점 차이는 차단하지 않고 warning으로 남긴다. 자책점도
  중계만으로 임의 판정하지 않는다. 특히 실책 출루처럼 자동 타점 판정이 불가능한 결과에는 0타점을
  합성하지 않는다.

## 파일 배치

| 상태          | 경로                                         | 의미                                                     |
| ------------- | -------------------------------------------- | -------------------------------------------------------- |
| 원천 증거     | `source/<season>/<gameId>/`                  | gzip endpoint payload와 manifest                         |
| 현재 포인터   | `current/<gameId>.json`                      | V2 ready/quarantine/source_failure 단일 권위와 표시 요약 |
| 현재 artifact | `active/<gameId>/<generation>-<hash>.*.json` | 포인터가 가리키는 immutable generation                   |
| 대체 이력     | `superseded/<gameId>/`                       | 이전 generation/content-hash snapshot                    |
| 최초 원장     | `original/<season>/<gameId>.json`            | 최초 정리 원장, 한 번만 기록                             |

KBO 선수 등록부는 경기 수집과 별도 권위다. `registry:sync`가 Register/Trade 원문을
`registry/source/<season>/<run-id>/` 아래 HTML/JSON gzip과 strict hash metadata로 저장한다. DB에는
artifact key와 hash만 두며 동일 run resume은 같은 request key의 원문 hash가 같을 때만 허용한다.
Register/Trade 파싱 규칙은 provider 경계인 `collection`에만 있고 game-core에는 들어가지 않는다.

KBO 기록정정현황도 별도 source 권위다. 수집기는 landing HTML, 시즌/시리즈 control 응답과
`/ws/Record.asmx/GetRecordCorrectList`의 모든 page를
`record-corrections/source/<season>/<run-id>/`에 gzip으로 원자 저장한다. 요청은 `listCn=100`, 전체 월,
빈 팀·최초/정정 기록 필터를 사용한다. 12개 열, `원정:홈`, 줄바꿈된 `DH1/DH2`, `3초/3말`, 타순,
선수 `<br>` 목록과 `값 A→B`를 strict하게 파싱한다. `루타/루타수`, `자책/자책점`처럼 실제 표에
존재하는 명칭 변형만 명시적으로 canonical stat으로 바꾼다. 알 수 없는 통계는 버리지 않고
`unknown` 증거로 남긴다.

한 source revision은 control과 모든 시리즈 pagination이 완전할 때만 seal한다. 동일 bundle hash는
새 revision을 만들지 않는다. 중단된 run은 저장된 gzip과 metadata hash를 검증한 뒤 남은 request만
수집한다. 실제 KBO 호출은 운영 adapter에만 있고 테스트는 2024 공식 표 구조를 비식별화한 fixture만
사용한다.

finding은 `StoredFindingEnvelopeV2`로 저장한다. `producer`와 `lifecycle`이 영구 보존,
`unresolved`가 남아 있는 동안의 보존, compiler 재계산 대상을 명시하며 문자열 code prefix로 수명을
추측하지 않는다. envelope에 finding이 하나 이상일 때만 sidecar를 만들고 비면 제거한다.

typed `unresolved` 행의 차단 finding은 compiler가 한 번만 생성한다. mapper와 compiler가 같은
문제를 중복 기록하지 않으며, 보정 session은 sidecar의 비재현 가능 source finding과 현재 전체
compile finding을 합쳐 저장 분류를 결정한다.

모든 current 전환은 writer lock 아래 target write/fsync, transition journal, current manifest atomic
replace와 directory sync, 이전 artifact의 superseded 이동, journal 제거 순서로 수행한다. startup은
journal을 idempotent하게 roll-forward하며 journal 없는 orphan active artifact나 hash 불일치는
persistence-blocked로 중단한다. command history, before/after snapshot, changes audit은 만들지 않는다.

legacy `staging/<season>`·`quarantine/<season>` 배치는 자동 추측하지 않는다. 먼저
`pnpm workspace:migrate -- --dry-run`으로 충돌을 확인하고, API writer를 중지한 상태에서 검증된 DB와
workspace 쌍 backup을 만든 뒤에만 `--apply --backup <verified-path>`를 실행한다. 둘 이상의 current
후보가 있으면 명시적 resolution 파일 없이는 중단한다.

V2 current manifest의 ready/quarantine entry는 원장의 `metadata.gameDate`와 `teams`에서 만든 strict
`displaySummary`를 가진다. source failure는 season·날짜·팀을 game ID에서 추론하지 않고
`displaySummary: null`을 유지한다. V1 manifest가 남아 있으면 startup은 persistence-blocked로 중단하고
같은 `workspace:migrate`가 artifact/document/content hash를 검증한 뒤 upgrade journal과 atomic replace로
승격한다. dry-run은 V1 수, source failure 수, 파생 가능한 요약과 검증 실패를 보고할 뿐 파일을 바꾸지
않는다.

목록 표시에는 `WorkspaceCatalog` 메모리 인덱스를 사용한다. startup에서 current 원장·finding의
무결성을 검증한 결과로 경기별 표시 요약, finding 수와 superseded 수를 채운다. 대시보드·수집·DB·
보정 목록은 이 요약을 공유하므로 변경 없는 조회는 파일을 읽지 않는다. 반환한 목록의 수정이 다음
조회에 영향을 주지 않도록 사본을 제공한다. 경기 상태·통계·원장을 별도로 계산하거나 저장하지 않는다.

current 전환의 시작·완료·실패 때 해당 경기의 요약만 무효화한다. 실패 전에 current가 교체된 경우도
포함한다. 다음 조회는 그 경기의 최신 manifest와 finding 수·이력 수를 다시 읽고, 중첩 조회는 작업을
공유한다. 갱신 도중 추가 저장이 끝나면 이전 읽기 결과를 버리고 최신 상태를 다시 확인한다. 여러 경기의
갱신도 파일 읽기는 최대 16개로 제한하며, 읽기 오류를 오래된 요약으로 숨기지 않는다.
이 인덱스는 파일 권위가 아니므로 collection token, correction base hash, 원장 읽기와 DB import는
기존 파일 검증을 유지한다. 외부 파일 유지보수에는 API writer 중지가 필요하며 재기동 시 다시 구축한다.

현재 DB revision과 같은 `sourceBundleHash`로 명시적 재수집한 경우 draft와 새 revision을 만들지 않는다.
hash가 달라졌을 때만 current revision 번호와 document hash를 `revisionBase`로 가진 새 작업 문서를
staging 또는 quarantine에 둔다.

## Immutable source에서 파생 원장 재생성

원천 보존 규칙 자체의 구현 오류를 조사할 때만 `maintenance:rebuild-derived`를 사용한다. 이 작업은
Naver를 호출하지 않고 현재 staging/quarantine 문서가 가리키는 source manifest와 모든 endpoint
hash를 검증한 뒤 임시 workspace에서 다시 map·compile한다. 실행은 검증만 하고 임시 결과를 제거한다.
과거의 `--confirm-derived-replacement` season 디렉터리 교체는 versioned current manifest 도입 후
금지된다. 검증 결과의 적용은 경기별 correction 또는 검증 backup을 요구하는 workspace migration
상태 머신을 통해야 한다.

실행 전 API writer를 중지해야 하며 활성 journal이나 DB 적재 경기가 하나라도 있으면 거부한다. 새
원장의 개수·original 일치·source hash를 재검증하고 재생성한 격리 경기 수가 현재 격리 경기 수보다
늘면 주요 blocking code와 함께 중단한다. `.data/source`, current source-failure artifact, `.env`와
PostgreSQL volume은 변경하지 않는다.

수집 화면은 SSE마다 전체 catalog를 다시 읽지 않는다. staging 제외처럼 문서를 바꾸지 않는 진행
이벤트는 작업 목록만 갱신하고, 실제 경기 저장 결과와 terminal event에서 catalog와 dashboard를
갱신한다. 동시에 진행 중인 같은 query를 새 이벤트가 취소·재시작하지 않게 한다.
수집 화면은 기간별 집계에서 날짜와 경기로 탐색하며 경기 목록과 수집 기록을 서버에서 페이지로
조회한다. 행에는 날짜·대진·저장 상태·검증 결과·DB 저장 여부를 표시하고 선택한 경기만 상세를 연다.
상단 실행 영역은 탐색 위치와 별개인 대상 기간·조건·선택 수를 유지한다. 과거 결과는 수집 기록 탭에서
현재 상태와 구분해 표시한다. URL 상태를 우선 복원하고, URL이 없으면 마지막 기간과 탐색 위치를
복원한다. 모바일은 목록→상세 방식으로 전환한다.
원천 실패의 날짜가 이전 수집 결과에서 확인되었다면 `collection/known-games`의 hash 검증된 작은
요약을 참조한다. 새 일정에 빠져도 확인된 날짜를 유지하며, 전체 이력이나 원장을 읽지 않는다.
catalog 조회는 startup과 실제 원장 사용 시 수행하는 전체 artifact 무결성 검사를 반복하지 않는다.
current manifest와 strict finding envelope만 bounded concurrency로 투영하며, 보정·적재처럼 원장을
사용하는 경계에서는 선택한 current document와 content hash를 다시 검증한다.

## 원천 실패와 재시도

일정, preview, relay 또는 record 필수 endpoint가 없거나 전송에 실패하면 원장 파일을 만들지 않는다.
재시도는 새 collection job으로 수행한다. strict 원장이 만들어진 뒤의 해석 문제는 source failure가
아니라 quarantine finding이며 `/correct`에서 보정한다.
