# 경기 재생 운영

스트라이크존은 타자 키로 계산한다. 2024년까지는 2024 규칙, 2025·2026년은 2025 규칙을 사용하며
트래킹 존으로 대체하지 않는다. 키가 없으면 계산 불가다. [정책·구현·검증](strike-zone.md)을 따른다.

재생 화면의 경기 목록은 `/api/v2/games?authority=database`만 조회한다. 전체 수집 목록과
query key를 구분하면서 catalog 무효화는 함께 적용하므로 적재·새 revision 뒤 최신 목록을 읽는다.

경기 재생은 PostgreSQL의 seal된 typed revision을 직접 사용한다. staging 원장을 복원해 replay하거나
브라우저에서 reducer를 다시 돌리지 않는다.

## 원자적 frame

frame의 단위는 원장 행이 아니라 DB `play_facts`의 상태 변경 단위다.

- 타석 결과와 연결된 주자 이동: 한 frame, 원장 문구는 `play_events` 순서로 함께 표시
- 투구: 독립 frame
- 독립 주자 이동: 같은 live-ball 사유로 연속된 주자 행은 한 frame, 그 밖에는 독립 frame
- 교체와 반이닝 경계: 각각 독립 frame
- 판독·공지·휴식: 상태 비변경 frame 또는 관련 play의 주석

타석 결과 play는 타자 기본 movement와 원장의 연결 주자 이동을 모두 포함하며 상태는 전후 한 번만
바뀐다. 원장에 파생 문구를 쓰지 않아도 frame에서는 구조화 fact로 사람이 읽는 보조 설명을 만들 수
있다. 원천 문구가 있으면 그것을 우선 표시한다.

## 무결성

재생 API는 다음을 검증한 seal revision만 반환한다.

1. manifest count와 typed fact count
2. 원장 fact와 최종 구조 fact 전체의 projection hash
3. frame 순서·상태 전후·PA bridge·movement와 저장 hash
4. 실제 pitch마다 canonical tracking 0..1과 `trackingId`별 관측 보존

DB 적재 시에는 DB에서 다시 읽은 원장 fact를 전체 compile해 저장된 play·상태·PA·기록과 일치하는지
이미 확인한다. 공개 replay 요청은 최종 typed fact를 직접 읽는다. 불일치는 frame을 반환하지 않고
`persistence` integrity 오류로 종료한다.

새 manifest 요청은 항상 DB 무결성을 다시 검증한다. 이후 frame page는 그 검증을 마친 불변 bundle을
최대 64MiB·16개·미사용 60초 범위에서 재사용한다. 만료·퇴출 후에는 다시 DB를 검증한다. 응답은
호출자마다 복제하며 cursor의 game/revision/document/frame hash 검사는 각 page에서 유지한다.

종료 결과가 없는 PA는 원인을 가진 partial lifecycle로 보존한다. 주루사 제3아웃 partial은 실제
투구를 포함하지만 공식 PA·타수·투수 상대 타자 수에는 포함하지 않는다. 다음 반이닝 이벤트가 해당
PA bridge에 섞이지 않는다.

## API

relay event의 선택 속성 `pitch`는 DB `baseball.pitch_facts`에서 읽은 `speedKph`·`pitchType`을
제공한다. 둘 다 없는 V3/과거 투구에는 `pitch` 자체를 생략해 기존 frame hash를 유지한다.
재생 화면은 tracking이 없는 투구에도 두 값을 표시하며 없는 항목은 `미제공`으로 표시한다.

- `GET /api/v2/games/{gameId}/revisions/{revision}/replay-manifest`
- `GET /api/v2/games/{gameId}/revisions/{revision}/replay-frames?limit=250&cursor=...`

manifest에는 revision, document/projection/frame hash, frame·tracking 수, 팀, 최종 상태와 validation
요약이 들어간다. cursor는 경기 ID·revision·hash·다음 위치에 결합된 opaque 값이다. 변조하거나 다른
경기·revision에 재사용할 수 없고 한 page는 최대 1,000 frame이다.

각 frame은 play 전후 상태, 원장 행, 현재 수비진·PA·tracking과 함께 DB typed runner movement를
포함한다. movement에는 주자와 책임 투수, 출발·도착 base, 결과, 아웃 유형, 원천/파생 구분과 source
event 연결이 들어간다. frame 응답 구조가 바뀌면 frame hash도 바뀌므로 기존 cursor를 재사용하지
말고 새 manifest부터 다시 받아야 한다.

## 브라우저 재생

`/replay`는 시즌과 경기 월을 고른 뒤 날짜별 경기 수가 표시된 달력에서 날짜를 선택해 seal된 DB
경기를 좁힌다. 날짜를 식별할 수 없는 fixture나 운영 자료는 경기 ID 즉시 검색으로 계속 찾을 수 있다.
검색 결과 수, 현재 선택, revision 로딩 상태를 같은 패널에서 확인할 수 있고 방향키로 결과 카드 사이를
이동할 수 있다. 경기 변경 패널은 현재 재생 화면 위에 열리며, 새 경기 로딩이 성공하기 전에는 기존
replay를 지우지 않는다. `선택 경기 재생`을 누르면 manifest와 모든 frame page를 받아
순서·개수·hash를 확인한다. 이후 처음·이전·재생·다음·끝, scrubber와
0.5×/1×/2×/4× 속도는 메모리 frame index만 바꾼다.

화면에는 다음을 표시한다.

- 원정·홈 점수, 이닝/초·말, B/S/O와 1·2·3루
- 현재 타자·투수와 PA 투구 수
- 한 play에 속한 원장 문구와 구조화 movement
- 현재 수비 선수와 포지션
- 연결된 canonical tracking 하나와 wide scalar metric
- 좌표 metric이 있을 때 포수 시점 스트라이크 존

tracking 좌표가 없으면 위치를 추정하지 않고 metric만 표시한다. `crossPlateY`는 높이가 아니라
홈플레이트의 종방향 y 기준 좌표다. `crossPlateX`와 신장으로 계산한 `strikeZone` 경계가 있고 직접 높이가 없을 때는
`y0/vy0/ay`로 첫 물리적 교차 시점을 구한 뒤 같은 시점의 `z0/vz0/az`로 홈플레이트 통과 높이를
계산한다. 필요한 값이 하나라도 없거나 비정상이면 차트를 만들지 않는다.
DB 분석도 같은 신장 기준으로 존 안팎을 판정한다. `0009_player_height_supplements`의 zone formula 5는
같은 경기·같은 시즌 자료와 검토한 공식 프로필에서 확정한 DB 키를 사용한다.
플레이트 Y가 동일하고 높이가 다른 궤적, 경계·누락·교차 불가 사례를 SQL과 재생 테스트에서 공유한다.

웹 구현은 재생 도메인 상태를 다음 경계로 나눈다.

- `replay-page`: 화면 조합과 재생 결과 표현
- `use-replay-page-controller`: catalog/revision 조회, 선택 전이, 로딩과 재생 타이머
- `replay-game-picker`: 검색·시즌·달력·revision 선택 UI
- `catalog`: DB catalog의 strict 날짜·팀 필드로 필터와 달력 셀을 만드는 순수 결정론적 모델

검색 결과는 고정 높이 virtual list로 표시한다. 선택 상태는 canonical filtered index를 소유하고
viewport에는 overscan을 포함한 구간만 렌더링한다. 따라서 전체 option이 DOM에 없어도 방향키,
Home/End와 `aria-activedescendant`/`aria-setsize`/`aria-posinset` 관계는 전체 목록 기준으로 유지된다.

첫 DB 경기, current revision과 유효한 달력 월은 조회 결과에서 파생한다. 별도 effect로 복제 상태를
동기화하지 않으며, effect는 검색창 focus와 재생 timer처럼 브라우저 외부 시스템과의 동기화에만
사용한다. 새 경기 로딩 전에는 선택 상태와 이미 불러온 replay 상태를 분리해 기존 화면을 유지한다.

## 실행

```powershell
docker compose up -d
```

브라우저에서 <http://127.0.0.1:8080/replay>를 연다.
