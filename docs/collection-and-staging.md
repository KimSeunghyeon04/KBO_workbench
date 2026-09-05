# 수집과 staging 운영

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

투구 payload는 선택적인 `speedKph`(유한 양수)와 `pitchType`(제공 구종명)을 가진다. collection은
`textOptions` 투구 행의 `speed`와 `stuff`를 해석하며 `ptsOptions`, tracking 좌표와 pitch ID 유무에
의존하지 않는다. 빈 값은 속성을 생략하고, 잘못된 값은 endpoint/block/row/event ID와 원문을 포함한
`source.pitch_metadata.invalid_speed` 또는 `invalid_stuff` warning을 남긴다. 구종 재분류는 하지 않는다.

1. 격리된 Playwright context가 완료·미취소 경기 ID를 탐색한다.
2. 현재 workspace에서 이미 `staging`인 경기 ID는 외부 요청 없이 완료 처리한다. `quarantine`,
   원천 실패와 미수집 경기는 계속 처리한다. staging 제외 진행은 경기별 파일 쓰기나 SSE 행을 만들지
   않고 한 번의 batch 진행으로 journal과 화면에 반영한다.
3. HTTP adapter가 preview, relay summary, 이닝별 relay와 record를 가져온다.
4. endpoint payload를 canonical JSON gzip과 manifest로 `.data/source`에 불변 저장한다. source
   경로의 season은 경기 ID 접두사가 아니라 preview의 실제 경기 날짜에서 정한다.
5. normalizer가 `textRelays[]` 배열 위치가 아니라 provider block `no`를 기준으로 원천 순서를
   복원하고 반복·정정 suffix를 포함한 모든 의미 행을 원천 위치별로 방출한다.
6. mapper가 원천 행마다 결정적 event ID와 정확한 endpoint·block·행 위치를 부여한다.
7. compiler가 strict 참조, 선수·타석 경계, 원자적 play, tracking, 상태·PA·기록과 원천 관측을
   검증한다.
8. 차단 finding이 없으면 staging, 있으면 quarantine으로 저장한다.

## 원장 보존 원칙

- 의미 있는 Naver 중계 행은 typed 행, `administrative`, `review` 또는 `unresolved` 중 하나로 남긴다.
- 원천에 없는 타석 시작·반이닝 종료·투구·결과·주자 이동을 합성하지 않는다.
- 한 행을 해석하지 못하면 원문, sanitized source type, 추정 가능한 kind와 원천 위치를
  `unresolved`에 보존하고 후속 행 처리를 계속한다.
- 공지, 마운드 방문, 휴식, footer, 상태를 바꾸지 않는 판독도 버리지 않는다.
- 광고와 상태 snapshot의 불필요한 필드, 원천 payload 전체는 저장하지 않는다.
- Naver 원문은 `relayText`에 1~1,000자로 trim해 저장한다. 파생 문구를 원문처럼 만들지 않는다.

## 정규화 결정 규칙

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
남아야 하는지는 원장을 나란히 확인한 사용자의 명시적 correction으로만 바꾼다.

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
catalog 행은 고정 높이 viewport virtual list로 표시해 전체 경기 수와 무관하게 화면에는 보이는 구간과
overscan만 둔다. canonical catalog 순서와 서버 문서 identity는 렌더링 구간과 분리한다.
수집 화면은 상단 명령 바, 실행 중 상태 banner, 왼쪽 경기 가상 목록과 오른쪽 상세로 구성한다.
목록 행에는 날짜·대진·현재 권위·갱신 시각만 두고 finding 수와 행동은 상세로 옮긴다. 과거 작업은
활동 기록 drawer에서 선택하고 요청 scope, 성공·검토·원천 실패·건너뜀을 상세에 표시한다. 화면
상태는 URL 검색 파라미터를 사용하며 모바일은 목록→상세 방식으로 전환한다.
catalog 조회는 startup과 실제 원장 사용 시 수행하는 전체 artifact 무결성 검사를 반복하지 않는다.
current manifest와 strict finding envelope만 bounded concurrency로 투영하며, 보정·적재처럼 원장을
사용하는 경계에서는 선택한 current document와 content hash를 다시 검증한다.

## 원천 실패와 재시도

일정, preview, relay 또는 record 필수 endpoint가 없거나 전송에 실패하면 원장 파일을 만들지 않는다.
재시도는 새 collection job으로 수행한다. strict 원장이 만들어진 뒤의 해석 문제는 source failure가
아니라 quarantine finding이며 `/correct`에서 보정한다.
