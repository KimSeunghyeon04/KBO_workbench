# 보정 운영

보정 worker는 compile/command와 같은 메시지에서 문서 hash·strict 사본·event context·findings를
준비한다. 준비 실패는 원장·version·undo/redo를 바꾸지 않는다. 명령 미리보기는 기존 version의
snapshot을 재사용하고 명령 반영·undo/redo·원본 불러오기는 새로 준비한다. commit 뒤에는 같은
검증 결과를 유지하면서 저장 finding과 세션 metadata만 갱신한다. 전체 응답 계약은 유지한다.
원문 첫 조회도 worker에서 파일 읽기·압축 해제·endpoint 및 전체 bundle 검증을 마친 뒤 캐시한다.
원문 cache 용량은 worker에서 계산하며 API에서 원본 전체를 다시 직렬화하지 않는다. 검증된 원본은
공용 worker 두 개에 각각 최대 16MiB/4건, idle 5분 캐시로 보관하고 선택 행의 근거만 API로 전달한다.
캐시는 원본 hash·game·season·workspace 경로에 결합하며 세션을 닫았다 다시 열어도 재사용할 수 있다.

보정 명령과 사본 열기·undo/redo의 컴파일은 API와 분리한 공용 CPU worker에서 실행한다.
session mutex는 계산 완료까지 유지하며 실패하면 문서·version·history를 바꾸지 않는다.
기록정정 제안은 worker마다 소유한 원장 하나의 strict compile을 재사용한다. 제안 결과는
문서 hash·공지 전체 내용·binding별 8MiB/128개, compile 결과는 16MiB/16개까지 5분간 재사용한다.
조회 때 현재 문서·source findings·DB base를 다시 확인하므로 저장·되돌림·새 revision을 반영한다.
타석 매칭의 전체 컴파일도 같은 공용 worker에서 실행한다. 공지 평가마다 후보 경기의 검증된
원장을 한 번 읽고 제안에 재사용한다. 제안 계산 후 DB current revision·document hash를 다시
확인하여 변경·삭제된 base는 revision conflict로 거부한다. worker 실패 시 평가를 저장하지 않는다.

## 범위

Database에서 current revision을 다시 열면 workspace가 공용 worker에서 한 번 전체 컴파일하고
그 findings로 ready/quarantine을 결정한다. route는 compiler를 실행하지 않는다. 계산 실패 시
기존 original/current가 유지되고, 차단 finding은 quarantine과 함께 저장한다.
drawer는 입력 상태·명령 제출·포커스를 관리한다. `event-fields`는 타석·투구, 주자 이동, 교체,
판독·안내 입력을 종류별 컴포넌트로 연결하며 기존 editor registry와 autofill 규칙을 사용한다.

보정 대상은 `staging`과 `quarantine`의 `StagingGameDocumentV2` 원장이다. sealed DB fact는 직접
수정하지 않는다. Database 화면에서 current revision을 V2 correction draft로 reopen한 뒤 같은 파일
경로에서 교정하고 current+1 revision으로 적재한다. 브라우저는 정본이 아니며 API가 session 작업
사본을 소유한다.

작업 사본 생성은 선택한 경기의 versioned current manifest와 그 manifest가 가리키는 원장·finding만
검증해 읽는다. 전체 경기 catalog 재스캔은 session 생성 경로에 포함하지 않는다.
보정 목록은 별도 경량 API에서 current manifest의 경기 ID·시즌·권위·경기일·대진·갱신 시각만 읽는다.
finding 개수는 목록에서 계산하거나 표시하지 않고, 선택한 작업 사본을 연 뒤 현재 compiler 결과로
표시한다. 경기일과 대진은 current manifest V2의 strict `displaySummary`이며 game ID에서 파싱하지
않는다.

자유 JSON 편집기는 두지 않는다. 다음 구조화 명령만 지원한다.

- 원장 행 추가·삭제·전체 교체·한 칸 이동·위치 지정 이동
- source 행의 비교용 관측값 수정 (`update_observed_state`)
- roster 선수 정보 교체
- 공식 타자·투수 기록 교체
- tracking candidate 연결·중복 지정·제외·연결 해제
- 여러 명령을 하나의 undo/redo 단위로 묶는 batch

이벤트 행 수정은 기존 event ID와 source 위치를 유지한다. 수동 추가 행은 UUIDv7 ID를 사용하고
사용자가 확정한 중계 문구가 반드시 필요하다. 모든 mutation 뒤 sequence를 배열 순서대로 다시
부여하고 strict decode와 전체 compiler를 실행한다.

끝내기 안타의 누락 주자 이동을 명시적으로 보정한 뒤 원문의 종료 잔루 표시와 달라도, compiler가
최종 끝내기 플레이임을 확인하면 베이스 관측 차이만 차단 대상에서 제외한다. 점수·아웃·공식 기록은
계속 검증하며, 이 끝내기 규칙은 관측값을 편집하거나 추가 주자 이동을 자동 생성하지 않는다.

## 관측값 수정

원문과 대조해 관측 오류를 확인한 경우 행 수정 창의 `관측값 수정 (검증용)`에서 볼·스트라이크·
아웃·양 팀 점수·베이스를 수정한다. 빈 숫자와 미관측 베이스는 비교 대상에서 제외하며 0은 관측된
값으로 유지한다. 베이스는 선수 지정·선수 미상 점유·주자 없음으로 구분한다.

`update_observed_state`는 source 행의 `observedStateAfter`만 교체한다. 수동 행에는 적용할 수 없다.
모두 비운 입력은 관측 속성을 제거한다. 이벤트 ID·소스 위치·중계 원문·payload·tracking과 최초 원본,
immutable source bundle은 유지한다. 원래 관측값은 근거 패널의 원문 또는 최초 원본에서 확인한다.
일반 `replace_event`는 기존 관측값을 유지하며 이 전용 명령으로만 명시적으로 바꾼다.

관측값만 편집하면 전용 명령 한 건을 보내고 이벤트 내용도 편집하면 두 명령을 atomic batch로
보낸다. session version, 전체 strict compile, undo/redo, 저장·재열기는 기존 경로를 사용한다.
보정된 관측도 비교용 증거이며 계산 상태·통계에 주입하지 않는다. DB는 기존 typed observation
컬럼에 보정 원장의 값을 투영하므로 document 및 projection 계약 변경은 없다.

## 다중 행 추가

경기 선택은 실제 경기일·대진·저장 상태를 표시하고 시즌·시작일·종료일·팀/날짜/ID 검색으로 좁힌다.
검증 결과는 같은 반이닝·종류·심각도·출처별로 접어 보여주되 개별 finding의 원천 위치를 유지한다.
그룹이 같은 원인이라는 뜻은 아니다. 최초 미적용 차단 행으로 이동하고 명령 전후 해소·신규 차단 수를
확인한다. 원문 패널은 선택 행의 선수·투구·관찰 상태를 먼저 보여주고 전체 JSON은 접어서 보존한다.

저장 뒤 작업 사본을 닫고 `이 경기 DB 적재`, `다음 검토 경기`를 제공한다. 단건 적재는 저장 시 문서
hash를 함께 제출하므로 그 뒤 수정된 문서를 조용히 적재하지 않는다. 저장·적재의 실패는 구분한다.
DB 저장 직후 작업 파일 정리가 진행 중이면 조회를 유지하고 정리가 끝난 뒤 목록과 건수를 갱신한다.
행정 이벤트 편집기의 `콜드게임 종료 선언`은 기존 structured command와 undo/redo 경로를 사용한다.

투구 편집기의 구속·구종 입력은 선택 사항이다. 다른 필드만 수정해도 기존 값이 유지되며 입력을
비우면 해당 속성을 삭제한다. 변경·삭제는 기존 `replace_event`와 session undo/redo를 사용한다.
투구 요약은 좌표 유무와 무관하게 구종·구속을 표시하고, 제공되지 않은 값은 `미제공`으로 구분한다.

`행 추가` drawer는 서로 다른 종류의 이벤트를 순서형 draft 목록으로 최대 100개까지 작성한다.
각 draft는 생성 시 안정적인 draft ID와 UUIDv7 event ID를 받고, 선택·수정·위/아래 이동·삭제해도
ID가 바뀌지 않는다. 한 개는 기존 `add_event`, 두 개 이상은 기존 `correction_batch` 한 건으로
전송한다. 모든 child `add_event`는 drawer를 처음 연 canonical `beforeEventId`를 공유하므로 서버의
순차 삽입 결과가 목록 순서와 같은 하나의 연속 구간이 된다. 앞에 추가, 뒤에 추가와 원장 맨 끝
추가 의미도 그대로 유지한다.

후속 주자 이동은 앞선 queued `plate_result`, 후속 판독은 앞선 queued 이벤트의 안정적인 event ID를
참조할 수 있다. 재정렬로 참조 대상이 뒤로 이동하면 해당 draft는 `확인 필요`가 되고 제출할 수 없다.
`다음 행 추가`는 직전 draft의 회·초말을 이어받는다. 직전 행이 타석 결과 또는 그 결과에 연결된
주자 이동이면 같은 결과 연결을 제안한다. 중계 문구의 투구 순번은 canonical 원장과 현재 draft보다
앞선 queued 행을 합친 임시 순서로만 계산한다. 이 임시 순서는 표시·입력 보조이며 BSO·주자·점수를
브라우저에서 예측하거나 서버 정본으로 취급하지 않는다.

제출 전 모든 draft를 순서대로 검증하며 첫 오류 draft를 선택하고 입력 필드로 포커스를 옮긴다.
오류가 있으면 아무 command도 보내지 않는다. 서버가 batch를 거부해도 draft 목록과 입력을 보존한다.
서버 요청 중에는 선택·수정·재정렬·삭제와 닫기를 모두 잠근다. draft 추가·삭제·재정렬도 닫기 폐기
확인 대상이다. batch는 전체 성공 또는 전체 실패하고 session version은 한 번만 증가하며 한 번의
undo/redo로 전체 행을 이동한다. 성공하면 마지막 추가 행을 선택하고 반영한 행 수와 finding 변화를
알린다.

## 원장과 화면의 1:1 관계

이벤트 목록의 한 행은 JSON `events[]` 한 행이다. 타석 결과 아래의 숨겨진 movement 하위 행,
자동 타자 이동 행, 별도 canonical 이벤트 개념은 없다.

긴 원장은 고정 높이 목록에서 가상 스크롤한다. 화면에는 보이는 구간과 overscan만 렌더링하되,
행 번호·위아래 이동·삭제 뒤 선택은 항상 필터가 아닌 전체 원장 canonical 순서를 사용한다.

각 반이닝의 첫 원장 행과 `batter_start` 행은 각각 이닝·타석 접기 버튼을 제공한다. 접으면 경계
안의 후속 행만 화면에서 숨기며 JSON 이벤트, canonical 순서와 compiler 입력은 바뀌지 않는다.
접기·펼치기 버튼을 누르면 해당 이닝 또는 타석 시작 행을 함께 선택하여, 기존에 선택된 다른 행의
가상 목록 위치로 스크롤이 이동하지 않게 한다.
이닝 전체·타석 전체 접기와 모두 펼치기도 제공한다. 검색·종류·문제 관련 필터 중에는 접힘 상태를
보존하면서 조건에 맞는 모든 행을 표시하고 접기 버튼을 잠근다.

행에는 수정·위·아래·삭제와 더보기 메뉴를 항상 제공한다. 이동은 필터 결과가 아니라 원장 실제
순서를 기준으로 한다. 삭제 뒤에는 다음 원장 행, 없으면 이전 행을 선택한다. tracking이 연결된
투구를 삭제하거나 비투구 행으로 교체하면 직접 관측과 종속 duplicate를 보존한 채
`excluded/manual_other`로 함께 전환한다. undo는 원래 연결을 복원한다. ID 없는 투구끼리를 같은
투구로 판단하거나 대체 대상으로 자동 선택하지 않는다.

`unresolved`는 event ID와 원천 위치를 유지한 채 원하는 typed 행으로 교체할 수 있다. 문구도
명시적으로 수정할 수 있으며 최초 원문은 immutable source bundle과 최초 원본에 보존한다.
`review`와 `administrative`도 추가·수정·삭제할 수 있고 상태 preview 전후는 동일하다.

## 투구별 Tracking과 원천 증거

별도 tracking 후보 패널은 없다. 원장 투구 행을 선택하면 우측 상세에 연결된 tracking의
endpoint/block/row, 공급자 PTS 순번, scalar metric과 resolution을 표시한다. 정상적으로 linked 또는
duplicate인 관측은 확인 정보만 보이고 조작 버튼을 만들지 않는다. 실제 pending/conflict가 있을
때만 해당 투구 안에서 연결·연결 해제·제외를 제공한다. 대응 투구가 전혀 없는 관측만 finding 선택 시
같은 우측 상세에 `원천 tracking 예외`로 표시한다.

같은 ID의 투구와 tracking이 같은 block에서 각각 N개면 원천 occurrence 순서로 이미 1:1 연결된다.
한 투구의 완전히 같은 tracking 재전송도 첫 위치가 canonical이고 나머지는 duplicate로 자동 정리되므로
사용자가 둘 중 하나를 대표로 고르지 않는다. metric 충돌, 개수 불일치, 대응 투구 부재만 사용자가
실제 원장 행과 대조해 연결하거나 잘못된 관측을 제외한다. 공급자 PTS 순번은 제외 조건이 아니며
compiler 실제 투구 순번과 다르면 warning으로만 표시한다.

`원천 증거와 정규화 값`을 펼치면 정규화 payload와 별도로 immutable source의 선택 행 주변 canonical
relay JSON, 같은 block·sourcePitchId의 PTS JSON을 확인할 수 있다. 이 응답은 증거 열람용이며 compiler
입력이나 브라우저 계산에 사용하지 않는다.

- `link_tracking_candidate`: candidate 하나를 실제 pitch 하나에 연결한다.
- `unlink_tracking_candidate`: linked candidate를 pending으로 되돌린다.
- `mark_tracking_duplicate`: canonical candidate를 명시해 중복으로 분류한다.
- `exclude_tracking_candidate`: 근거 문자열을 남기고 분석에서 제외한다.
- `reconcile_tracking_plate_appearance_contexts`: 삭제된 PA ID를 가리키는 linked 후보와 동일 duplicate를
  현재 compiler PA로 일괄 복구한다.

수동 tracking 명령이 여러 관측을 함께 바꾸면 `correction_batch`로 전부 성공하거나 전부 실패한다.
매 command 후 compiler가 실제 pitch 1건당 canonical tracking 0..1과 link·PA·선수·이닝 문맥을 다시
검증한다. 재계산 가능한 `source.tracking.*`와 source pitch ID 반복 finding은 저장 당시 sidecar에서
현재 finding으로 승계하지 않으므로 해결한 차단이 다시 살아나지 않는다.

이벤트 추가·삭제·교체·이동 전후에 candidate가 같은 실제 투구에 계속 연결되고 편집 전 PA 문맥도
compiler와 일치했다면 candidate와 동일 duplicate는 편집 후 PA 시작 ID를 따라간다. 수동 재연결,
존재하는 다른 PA와의 불일치, compiler가 PA를 계산하지 못한 경우에는 자동 갱신하지 않는다. 이미
삭제된 PA를 가리키는 과거 작업본에는 관련 finding의 `삭제된 PA 문맥 재계산`을 한 번 적용한다.

## 타석 결과 편집

`plate_result` 편집기는 다음 원천 사실만 다룬다.

- 결과, 타자, 투수, 선택적 타점
- 결과 행이 직접 기록한 아웃 수
- 타자가 기본 결과와 다르게 생존한 경우의 도착 베이스
- `땅볼·뜬공·직선타·내야 뜬공`과 번트 여부
- 중계 문구

movement 입력은 없다. 타구 유형과 번트 여부는 타구 정보가 허용되는 결과에서만 표시한다. 볼넷,
고의4구, 몸에 맞는 공, 삼진, 방해 출루를 선택하면 두 입력을 숨기고 이전 값을 command에서
제거한다. 다시 인플레이 결과로 바꾸면 일반 결과는 `번트 아님`, 희생번트는 `번트`, 희생플라이는
`뜬공·번트 아님`을 제안한다. 기존 `isBunt` 미확정 값은 결과와 무관한 필드만 수정할 때 자동으로
`false`가 되지 않는다.

compiler가 만드는 타자 기본 movement는 화면의 전후 상태 설명에 사용할 뿐 JSON에 쓰지 않는다.
자동 중계 문구도 입력 보조 제안일 뿐이며 존재하지 않는 수비수·타구 방향·선수 ID를 만들어내지
않는다. 원천 문구 또는 사용자가 확정한 문구만 저장한다.

타석 결과 종류를 바꾸면 이전 결과에만 해당하던 타점, 직접 기록 아웃, 타자 생존 도착 베이스를
비우고 새 결과의 기본 타자 이동을 선택 항목에 표시한다. 타자·투수는 해당 canonical 위치에서
compiler가 확인한 현재 타석 선수를 자동 지정한다. 사용자가 직접 선택하면 자동 지정 표시가
사라지고 이후의 단순 rerender가 그 선택을 덮어쓰지 않는다.

## 주자 이동 편집

주자 이동은 항상 독립 `runner_advance` 원장 행이다. 타석 결과 뒤에서 추가하면 직전 결과의
`eventId`를 연결 대상으로 제안하지만 사용자가 다른 결과나 독립 사유를 고를 수 있다.

이 자동 연결은 실제 canonical 삽입 위치가 결과 행 바로 뒤일 때만 수행한다. 결과 앞에 추가하는
행을 미래 결과에 연결하지 않는다. 연결 play의 `before` 베이스에서 1루, 2루, 3루 순서로 첫 점유
주자와 출발 베이스를 자동 지정한다. 출발 베이스나 주자를 바꿀 때 반대 필드가 비어 있거나 자동
지정 상태일 때만 함께 맞춘다. 사용자가 직접 선택한 값과 기존 원장에 저장된 값은 유지한다.
따라서 같은 플레이의 2루→3루→홈 이동에서 시작 전 배치로 주자나 출발 베이스를 덮어쓰지 않는다.
점유 주자가 없으면 roster 선수를 임의로 선택하지 않는다. 입력의 야구 규칙 검증은 전체 compiler가
수행한다.

- 타석 결과 연결: `context.kind = plate_result`, `plateResultEventId` 필수
- 독립 플레이: `context.kind = independent`, 도루·견제·폭투·포일·보크 등 reason 필수

선수, 출발·도착 베이스, safe/out/scored, out 종류, 책임 투수, 제3아웃 대체 여부와 원문을
구조화한다. 타자 아웃은 원장 주자 행으로 중복 입력하지 않는다. 범타·삼진 등 결과로 확정되는
타자 상태는 compiler가 DB 최종 movement로 만든다. 기존 베이스 주자의 이동은 반드시 실제
`runner_advance` 행으로 보정해야 한다.

득점을 선택하면 도착 베이스는 홈으로 맞추고, 홈이 아닌 베이스로 바꾸면 일반 진루로 되돌린다.
아웃이 아닌 결과에서는 아웃 종류와 제3아웃 대체 값을 command에 넣지 않는다. 책임 투수는
명시적으로 확인한 경우만 저장하며 비어 있으면 compiler의 기존 책임 승계 규칙을 사용한다.
선택란에는 빈 값의 대용 문구인 `자동` 대신 현재 적용된 movement의 책임 투수 이름을 표시한다.
이 이름을 표시하는 것만으로 payload에 책임 투수를 고정하지 않는다. 서버가 전달한
`eventContexts[].runnerMovement`만 사용하며 현재 등판 투수로 대체하지 않는다. 미적용 행,
새 이동, 이동 내용 수정 또는 기존 명시 지정을 해제한 경우에는 `미확정 · 반영 후 확인`으로
표시하고 다음 전체 compile 응답에서 이름을 갱신한다. 문구만 수정한 경우에는 이름을 유지한다.

연결 결과 삭제, 잘못된 독립 사유, 상태 변경 행을 사이에 둔 잘못된 연결은 즉시 finding이 된다.
한 play에 연결된 전체 이동은 compiler가 임시 상태에서 원자적으로 검증하므로 실패 시 일부만
draft에 적용되지 않는다.

## 선수 검색과 문구

타자·주자는 해당 반이닝 공격팀, 투수·책임 투수는 수비팀 roster에서 검색한다. 교체 선수는 event
side, 공식 기록과 roster 수정은 선택 팀을 사용한다. 이름·ID·팀·포지션·타순 부분 검색, 키보드
탐색과 listbox 접근성을 지원한다. roster 밖 ID는 자유 입력하지 않는다.

수집 행의 `relayText`는 처음에는 Naver 원문이며 행 수정 창에서 보정할 수 있다. `replace_event`에
문구가 제공되면 수정한 값을 저장하고, 문구가 생략되면 기존 값을 유지한다. 최초 원문은 immutable
source bundle과 최초 원본에 보존하며 근거 패널에서 확인한다. 원장·검색·DB 적재·재생은 보정된
문구를 사용한다. 수동 행도 사용자가 확인한 문구를 저장한다.

문구만 수정하면 편집기에 노출되지 않는 속성을 포함해 기존 payload·관측값·source identity를
유지한다. 선수·판정·주자 이동은 문구에서 재해석하지 않으며 구조화 필드로 수정한다. 전체 compile,
session version, undo/redo, commit·재열기는 기존 보정 경로를 사용한다.

`문구 제안`은 버튼을 누른 경우에만 현재 입력을 바꾸고 자동 저장하지 않는다. 제안에는 roster의
선수 이름과 확인된 타순만 사용하며 선수 ID, 주변 중계 행의 타구 방향이나 수비 위치를 복사하거나
추측하지 않는다. 예시는 `1회초 시작`, `1번타자 선수A`, `3구 스트라이크`,
`선수A : 땅볼 아웃`, `1루주자 선수A : 폭투로 2루까지 진루` 형식이다.

투구의 `N구`는 편집 대상의 canonical 위치에서 현재 타석 시작 뒤에 앞서 나타난 `pitch` 원장 행
수를 기준으로 한다. 교체 편집 중인 자기 행은 제외하고 자동 볼·자동 스트라이크·`no_pitch`도 중계
표시 순번에는 포함한다. 이는 원문 표현을 위한 순번일 뿐 compiler의 공식 투구 수가 아니며, 새 타석,
타석 결과 또는 반이닝 경계에서는 초기화한다. 활성 타석을 확인할 수 없으면 순번 없이 판정만
제안한다.

## 편집기 자동 지정

새 행, 행 종류 변경과 종속 상위값 변경에서는 compiler 상태와 원장에 이미 명시된 사실만 입력
보조에 사용한다. 자동 지정 근거는 각 필드와 `aria-live` 상태 메시지에 표시되며 자동값도 command
제출 전에는 서버나 파일에 반영되지 않는다.

- `batter_start`: 현재 타석에서 확인한 타자·투수. 활성 타석이 없으면 선택 행에 명시된 선수,
  같은 공격팀의 직전 타석 결과와 현재 명단·앞선 교체 타순으로 확정되는 다음 타자, 같은 반이닝의
  직전 명시 투수 순으로 보완
- `plate_result`: 현재 타석에서 확인한 타자·투수
- `pitch`: ID를 생략했을 때 실제 적용될 현재 타자·투수의 이름과 ID 표시
- `runner_advance`: 선택 베이스 점유 주자, 없으면 1·2·3루 순 첫 점유 주자
- `substitution`: 역할과 초·말에 따른 팀, 현재 타자·투수 또는 첫 점유 주자, 명단이나 앞선 교체에
  명시된 타순
- `review`: 같은 반이닝의 바로 앞 실제 이벤트

교체로 들어올 선수, 명단 순번이 불완전해 확정할 수 없는 다음 타자, 수비 위치, 판독 결과, 투구
판정, 타점, 주자 도착과 독립 사유는 자동 생성하지 않는다. 교체 역할·팀을 바꾸면 선수와 교체
부가값을 비운 뒤 새 범위에서 다시 지정한다. 이닝·초말을 바꿔 원래 위치 context가 무효가 되면
해당 context에서 자동으로 채운 값만 제거하고 사용자가 직접 확정한 값은 유지한다.

## Session, undo/redo, 저장

웹은 저장 후 최신 version으로 서버 session을 삭제하고, 다른 작업 사본으로 교체하거나 명시적으로
닫을 때도 DELETE를 보낸다. 미저장 변경이 있는 사본의 닫기는 확인을 받는다. 변경 없는 사본은 화면
이탈 시 정리한다. 미저장 사본은 남기고 sessionStorage에는 ID만 보관해 같은 탭의 복귀 시 다시 연다.
서버 재시작 후에는 메모리 사본을 복원할 수 없다. 동시에 열린 사본은 최대 64개이며 초과 생성은
`429 correction_session_limit`이다. 생성 시 30분 이상 조회하지 않은 변경 없는 사본만 회수하고,
진행 중인 명령·미저장 변경은 회수하지 않는다.

동일 session version의 응답은 한 번 계산해 두되 호출자마다 복제한다. 명령 뒤 전체 컴파일은 유지하며,
tracking context 보완이 문서를 바꾸지 않은 경우에만 바로 앞의 동일 문서 컴파일 결과를 재사용한다.
immutable source bundle은 game/season/hash별 전체 검증 후 최대 32MiB·8개·미사용 5분으로 재사용한다.
웹의 원문 조회 키에는 session version을 포함해 투구 연결 교정 후 tracking 증거가 갱신된다.
원본 비교는 문서가 바뀔 때만 계산한다. 기록정정 목록은 한 요청 안에서 동일 경기의 작업본 읽기와
차단 집계를 공유하고, 다음 요청에서는 현재 작업본과 DB base를 새로 확인한다.

모든 mutation은 `expectedSessionVersion`을 보내며 세션별 async mutex가 command, batch, undo/redo,
original load, 제안 적용과 commit을 순서대로 실행한다. expected version은 lock 안에서 검사하고 stale
version은 `409`로 거부한다. 웹은 한 번의
요청으로 즉시 적용하고 낙관적으로 화면만 먼저 바꾸지 않는다. 서버는 복사본에 명령을 적용하고
strict decode·전체 compile이 끝난 결과로만 작업 사본과 finding을 교체한다.

차단 finding은 명령 성공 자체를 막지 않는다. 보정 목적상 불완전한 중간 작업 사본이 필요하기
때문이다. 응답은 전후 hash, 원장 행 수, 차단·경고 수와 finding code 변화를 제공한다.

명령 또는 batch 하나가 undo/redo 한 단위다. 새 명령을 적용하면 redo stack을 비우고, 저장하거나
session을 다시 열면 메모리 history가 초기화된다. 입력 필드에 포커스가 없을 때 `Ctrl+Z`,
`Ctrl+Y`, `Ctrl+Shift+Z`를 지원한다. 영구 command audit이나 보정 중간 snapshot은 만들지 않는다.

저장 시 base document hash를 다시 확인한다.

- 차단 finding 없음: staging에 저장
- 차단 finding 있음 + 사용자가 허용: quarantine에 저장
- 차단 finding 있음: staging 승격과 DB 적재 금지

현재 파일 교체는 versioned current 상태 머신과 crash-recovery journal을 사용하고 성공하면 즉시
지운다. source_failure가 현재 권위가 된 뒤에도 명시적인 superseded snapshot ID로 복구 사본을 열 수
있고, session을 연 시점의 current content hash가 유지된 경우에만 현재 원장으로 복귀한다. 최초 정리 원장과 당시
finding은 `.data/original`에 한 번만 보존하며 보정으로 덮어쓰지 않는다.

차단 finding이 남은 작업 사본은 저장 화면의 확인란으로 quarantine 저장을 명시적으로 허용한
경우에만 저장할 수 있다. 확인 없이 API에 허용값을 자동 전송하지 않는다. 차단 finding이 없으면
확인란 없이 staging에 저장한다.

과거 envelope에서 `lifecycle=recomputed`인 compiler finding은 현재 compiler finding을 대신하지 않는다. 현재
compile이 깨끗하면 과거 값은 `저장 당시 finding` 필터에서만 이력으로 확인한다. 이 때문에 변경하지
않은 quarantine 문서가 `차단 0`이 될 수 있으며, 화면은 이때만 `staging 승격 가능`과
`staging으로 승격` 버튼을 표시한다. 승격은 사용자가 명시적으로 실행해야 하고 자동 이동하지 않는다.
staging의 변경 없는 문서와 차단이 남은 quarantine은 변경 없이 저장할 수 없다.

저장이나 staging 승격이 성공하면 웹은 열린 작업 사본과 행 선택·필터·drawer 상태를 닫고 경기
목록을 다시 읽는다. 완료 화면에는 경기 ID와 최종 현재 권위를 표시하며, 기록정정 링크로 연 session
query도 제거해 이미 저장한 session이 자동으로 다시 열리지 않게 한다.

`lifecycle=while_event_unresolved` finding은 대응 event가 현재도 `unresolved`일 때만 현재 차단으로 유지한다.
사람이 같은 identity를 typed event로 확정하거나 행 삭제를 명시적으로 적용하면 현재 finding에서는
제외하고, 최초 원장과 최초 finding에는 원천 증거로 계속 보존한다.

## 화면 탐색과 편집

보정 화면은 finding, 평탄 원장, 선택 행 상세의 3열 작업대다.

기록정정 검토함에서 연 보정 session은 상단에 KBO 공지의 경기·플레이·판정·정정일·원문 내용과
선수별 전후 공식 기록을 표시한다. 자동 제안 적용 가능 여부와 관계없이 수동 교정에 필요한 원문
근거를 같은 화면에서 확인할 수 있다.
검토함은 기본 `미처리` 큐(action_required/manual_review/unmatched), `완료·제외` 큐와 전체 범위로
나눈다. 목록 endpoint는 날짜·대진·전후 기록·상태의 경량 DTO만 반환하고 원문·참여 선수·통계 변경·
후보는 선택한 공지의 단건 endpoint에서 lazy-load한다. 목록과 상세는 각각 독립 스크롤하며 행동은
상세 하단 sticky bar에 둔다. 처리 성공 뒤 현재 항목을 미처리 큐에서 제거하고 다음 항목과 남은
건수를 알린다. 모바일은 목록→상세→목록 방식이며 URL 검색 파라미터로 범위·필터·선택을 복원한다.

- finding은 compiler의 결정론적 순서를 유지하며 메시지·code·행 검색, 심각도, 범주, 현재/저장
  당시 시점 필터를 제공한다. 기본 목록은 현재 finding이며 저장 당시 목록만 또는 두 시점을 함께
  볼 수 있다.
- finding을 선택하면 해당 canonical 원장 행으로 이동한다. 원장 검색·종류·문제 관련 필터가 행을
  숨기고 있으면 필터를 해제하고, 접힌 이닝이나 타석 안의 행이면 필요한 그룹만 자동으로 펼친다.
- 원장 행은 원문·구조 요약·compiler 계산 상태를 함께 표시한다. 상세 패널은 적용 전후 BSO·주자·
  점수와 관련 finding을 먼저 보여주고, event ID·원천 위치·raw payload는 접힌 기술 정보로 둔다.
- finding 목록과 관련 finding에는 `홈 점수: 예상 1 → 계산 2`처럼 필드별 원천 예상값과 compiler
  계산값을 표시한다.
- 공식 타자·투수 기록 finding은 `recordIdentity`의 선수 ID를 현재 roster의 팀·선수명으로 풀어
  표시한다. finding을 선택하거나 상단의 `타자 기록`·`투수 기록` 버튼을 누르면 우측 상세에서
  선수를 검색·선택하고 공식 제공값과 현재 compiler 계산값을 항목별로 비교할 수 있다. 불일치,
  공식 미제공, 계산 기록 없음과 compiler 검증 제외 항목을 구분하며 자책점처럼 compiler가 계산하지
  않는 필드는 일치로 간주하지 않는다.
- 최초 원장 비교는 추가·삭제·수정·순서 변경 이벤트의 전후 내용과 roster·tracking·공식 기록
  변경 수를 함께 표시한다.
- 투구 행에서 선수 ID를 생략해 현재 타석 상태를 사용할 때는 compiler가 해당 위치에서 계산한
  타자·투수의 팀, 이름, ID를 선택 항목에 표시한다. 계산 가능한 현재 타석이 없으면 확인 불가 또는
  미확정 상태를 명시한다.

행 추가·수정·위치 지정 이동은 우측 modal drawer에서 수행한다. drawer가 열리면 첫 입력으로
포커스가 이동하고 배경은 조작할 수 없다. `Escape`, 배경 또는 닫기 버튼으로 닫을 수 있으며 입력을
바꾼 뒤에는 폐기를 한 번 더 확인한다. 서버 compile 요청 중에는 폼과 닫기 동작을 잠그고, 닫힌 뒤
포커스는 drawer를 연 버튼으로 돌아간다.

## API

- `POST /api/v2/games/{gameId}/revisions/{revision}/correction-drafts`
- `POST /api/v2/correction-sessions`
- `GET /api/v2/correction-sessions/{sessionId}`
- `GET /api/v2/correction-sessions/{sessionId}/original`
- `GET /api/v2/correction-sessions/{sessionId}/source-evidence/{eventId}`
- `POST /api/v2/correction-sessions/{sessionId}/load-original`
- `POST /api/v2/correction-sessions/{sessionId}/commands`
- `POST /api/v2/correction-sessions/{sessionId}/undo`
- `POST /api/v2/correction-sessions/{sessionId}/redo`
- `POST /api/v2/correction-sessions/{sessionId}/commit`
- `DELETE /api/v2/correction-sessions/{sessionId}`

session 생성 source는 `staging` 또는 `quarantine`만 허용한다.
session 응답의 `calculatedRecords`는 같은 작업 사본을 서버 compiler가 계산한 선수별 타자·투수
기록이다. 웹은 이 값을 공식 기록 비교 표시용으로만 사용하고 별도의 기록 계산기를 두지 않는다.

## KBO 기록정정 제안

`/record-corrections` 검토함은 공지를 경기일·원정/홈 팀으로 current sealed revision에 정확히
맞춘다. 구장명은 표시용 증거이며 `대전`/`대전(신)` 같은 표기 차이나 누락으로 경기를 제외하지
않는다. 같은 날 같은 대진이 복수면 `DH1/DH2`와 Naver source identity가 함께 맞아야 한다.
공지에 DH 번호가 명시되면 DB에 한 경기만 있어도 번호가 맞아야 한다. 그 뒤
이닝·초말·타순과 경기 roster의 타자·투수 이름을 PA fact에 대조한다. 타순은 해당 이벤트 이전의
정규화된 교체 행에서 명시된 타순 또는 교체된 선수의 타순을 확인하며, 이후 수비 위치만 바뀐 행은
그 타순을 지우지 않는다. 공지에 투수가 여럿이면 PA의 실제 투수를 확인하고 각 통계는 같은 팀의
해당 이름 선수에게 따로 연결한다. 참가자 나열 순서로 대상 투수를 선택하지 않는다. 이름 후보가 하나가 아니거나
현재 값이 KBO 전후 어느 값과도 맞지 않으면 추측하지 않고 `수동 검토`로 둔다. 사용자가 고를 수
있는 대상은 서버가 저장한 경기·이벤트·선수 후보뿐이며 선택·무시·재검토 이력은 DB에 append-only로
남는다. 날짜·대진으로 찾지 못한 공지는 `경기 연결 필요`로 표시하며, 해당 경기 적재 후 현재 DB로
다시 평가한다. 공지 평가만 갱신하며 기존 원장이나 봉인된 경기 revision은 수정하지 않는다.

`보정 작업대로 이동`은 저장된 staging/quarantine 작업본을 우선해서 연다. 이미 진행 중인 수정,
finding과 revision base를 DB 사본으로 덮어쓰지 않는다. 작업본이 없고 공지 평가 이후 DB current가
바뀌었다면 현재 revision에서 경기·타석을 다시 매칭한 뒤 초안을 만든다. 대상이 더 이상 유일하지
않으면 갱신된 후보를 확인하도록 요청하고 초안은 만들지 않는다. 초안 준비 중 생긴 다른 작업본도
workspace 저장 경계에서 보존하며, 적용할 때의 session version/hash와 적재할 때의 stale base 검사는
그대로 유지한다.

검토함의 목록·상세는 저장된 현재 작업본도 확인한다. 지원 정정 항목이 모두 정정 후 값이고,
차단 finding이 없으며 DB current와 base가 맞는 staging 작업본은 `수정 완료 · DB 적재 대기`로
표시한다. 해당 경기의 Database 적재 대기로 바로 이동할 수 있다. 메모리 session에서만 고친 값은
저장 완료로 표시하지 않는다. 미완성/차단 작업본은 `수정 중`, DB base가 달라졌으면 `기준 기록 확인`으로
표시하며 작업본을 되돌리거나 없애면 다음 조회에 반영한다. 저장과 DB 적재 완료 시 관련 화면 캐시를
갱신한다.

이 진행 표시는 API의 선택 필드 `draftProgress`로 제공하는 조회 결과이며 DB case 상태를 바꾸지
않는다. DB 적재 전에는 미처리 큐에 남고, 목록 안에서는 검토 필요와 DB 적재 대기 수를 구분한다.
목록은 현재 작업본이 있는 공지만 검증하고 다른 공지의 원문·원장은 읽지 않는다. GET 조회는 공지 평가,
원장 저장이나 DB import를 수행하지 않는다.

제안은 `replace_event`와 지원되는 공식 타자·투수 line replacement를 기존 `correction_batch` 한
건으로 만든다. 원래 event ID, source 위치, 현재 `relayText`, 관찰 상태와 기존 runner movement는
보존한다. 안타 종류는 현재 종류를 유지하거나 루타와 실제 도착 베이스가 유일할 때만 바꾸며,
물리적 주자 상태를 바꿔야 하는 공지는 자동 제안하지 않는다. 야수 실책, 투수 상대 타수·희타와
알 수 없는 통계는 `현 범위 제외` 증거로 표시하고 batch에는 넣지 않는다.

지원 여부는 `(scope, statCode)` 조합으로 결정한다. 따라서 같은 `희비`라도 타자 희생플라이는 공식
기록 적용 대상이고 투수 피희생플라이는 원문 증거만 보존한다. 과거 source revision에 잘못
`direct`로 저장된 조합도 제안 생성 시 현재 계약으로 다시 낮춰 충돌이나 수동 검토를 만들지 않는다.
지원되는 판정 변경이나 공식 기록 변경이 하나도 없는 공지는 `지원 범위 외`로 분류하며 dashboard
알림에 포함하지 않는다.

공식 기록 행이 있는 선수의 선택 계수형 통계 중 비발생 시 생략되는 2·3루타, 고의4구, 사구,
희생번트·희생플라이는 KBO 전후 기록 비교에서 0으로 해석한다. 투수 고의4구도 같은 규칙을 따른다.
타석·투구 수·스트라이크 수처럼 coverage 자체가 없을 수 있는 생략값은 계속 미제공으로 취급한다.
이 비교 의미는 원천 원장에 누락 필드를 합성하거나 document hash를 바꾸지 않는다.

생략된 선택 계수의 0이 KBO 전후 어느 값에도 해당하지 않으면 KBO 정정 후 값을 채우는 명시적
제안을 만들 수 있다. 제안은 선수명·통계명과 `미제공 → 값`, `KBO 공지로 보완 예정`을 표시하고
기존 공식 기록 변경 command를 사용한다. 명시된 0을 포함한 기존 값의 충돌, 공식 기록 행 자체의
누락과 coverage 필드의 미제공은 이 보완 대상이 아니다. 조회만으로 값을 쓰지 않으며, 제안 적용
후 전체 검증과 undo/redo·저장·DB 적재 절차는 동일하다.

proposal hash는 session ID/version, base document hash, notice source hash와 batch를 묶는다. apply
요청 때 서버가 제안을 다시 만들어 hash가 다르면 `409`로 거부하고 session을 바꾸지 않는다. 전체
compile 뒤 새 blocking finding이 없고 지원 필드가 정정 후 값과 맞을 때만 적용할 수 있다. 적용은
session version을 한 번 증가시키는 하나의 undo/redo 단위이며 저장과 DB import는 기존 절차로 별도
수행한다. import 후 승인 document hash가 current revision으로 seal되고 정정 후 상태를 만족할 때만
`해결됨`과 적용 revision을 기록한다.

변경 명령이 없는 경우에도 지원 통계의 공식값과 compiler 계산값이 모두 공지의 정정 후 값인지
검증한다. 공식값만 맞고 원장의 RBI·장타 등 계산값이 다르면 이미 반영으로 처리하지 않는다.
자책점은 compiler 계산 대상이 아니므로 공식값만 확인한다. 차이가 남았으나 적용 가능한 batch가
없으면 구체적인 이유와 함께 수동 검토로 남기며, 알 수 없는 타점이나 물리적 이동을 합성하지 않는다.

추가 API는 다음과 같다.

- `POST/GET/DELETE /api/v2/record-correction-jobs`
- `GET /api/v2/record-corrections/summary`
- `GET /api/v2/record-corrections`와 `GET /api/v2/record-corrections/{noticeId}`
- `POST /api/v2/record-corrections/{noticeId}/review-actions`
- `POST /api/v2/record-corrections/{noticeId}/correction-drafts`
- `GET/POST /api/v2/correction-sessions/{sessionId}/record-correction-proposals/{noticeId}`

## 웹 사용 순서

1. `/correct`에서 검토 필요 경기를 연다. 필요하면 적재 가능 범위까지 넓힌다.
2. finding 검색·심각도·범주 필터로 문제를 좁힌 뒤 관련 원장 행과 현재 compile 결과의 전후 상태를
   본다.
3. 행 버튼이나 드로어에서 typed 원장 사실을 보정한다.
4. 작업 요약과 새 finding을 확인하고 필요하면 undo/redo한다.
5. 원본 비교에서 event ID 기준 추가·삭제·수정·순서 변경과 roster·tracking·공식 기록 차이를 본다.
6. 차단이 없으면 `현재 원장 저장`으로 staging에 반영한다. 변경 없이 깨끗해진 quarantine은
   `staging으로 승격`을 명시적으로 누른다. 차단이 남으면 확인란으로 허용한 뒤 `격리 원장 저장`으로
   quarantine에 반영한다.

`KBO 문자중계` 버튼은 유효한 공식 경기 ID를 KBO 1군 문자중계 URL로 열며 새 탭에는
`noopener noreferrer`를 적용한다.
