# A02. 선수·팀 성적 비교

선수 기본 기록의 자유 A/B 기간 비교는 [기간 비교](../period-comparison.md)를 따른다.
팀별 분자·분모를 서버에서 합산하고 기존 공식 성적 계산 함수를 재사용한다.

선행 조건: A01의 경기 범위. 기존 `database/examples/player-season-*.sql`과 typed 집계를 확장한다.

## 첫 화면과 지표

선수/팀, 시즌, 기간을 선택해 타격·투구 성적을 나란히 비교한다. 처음에는 구체적인 두 표를 만들고
사용자 수식 편집기나 임의 차원 피벗을 만들지 않는다.

| 지표                  | 분자·분모                                                           |
| --------------------- | ------------------------------------------------------------------- |
| AVG                   | H / AB                                                              |
| OBP                   | (H + BB + HBP) / (AB + BB + HBP + SF)                               |
| SLG / OPS             | TB / AB; OPS는 OBP + SLG                                            |
| 타자 K% / BB%         | SO / 공식 PA, BB / 공식 PA                                          |
| 투수 K% / BB% / K−BB% | SO / 공식 BF, BB / 공식 BF, 두 비율의 차이                          |
| 이닝                  | outs_recorded 원값; 화면에서 3아웃 단위로 표시                      |
| ERA                   | 동일한 ER 확인 경기들의 ER 합 × 27 / 해당 경기들의 outs_recorded 합 |

BB에는 IBB를 포함하며 별도 IBB 수도 표시한다. TB는 1B+2×2B+3×3B+4×HR다.
분모 0은 null이다. 경기별 비율의 평균 대신 분자·분모를 먼저 합한다.
ER 누락 경기가 있으면 전체 ERA는 null로 두고 ‘ER 확인 경기 ERA’를 별도 값·이닝·coverage로 표시한다.
RBI는 compiler가 가진 값과 근거 한계를 유지하고 이번 첫 순위의 핵심 지표로 삼지 않는다.

## 데이터와 API

선택 게임 집합에 current player-game fact를 연결한다. 구종·카운트별 타격 결과는 A08에서 다룬다.
선수의 이적 전후 소속은 해당 경기 team/roster snapshot 기준이며 현재 소속을 과거에 덮어쓰지 않는다.
canonical identity가 확정되지 않은 선수는 원 ID 범위를 유지한다.

`GET /api/v2/analysis/statistics/batting`과 `/pitching`을 별도 strict 계약으로 제공한다.
query는 season/date/competition, group=player|team, 선택적 playerId, 명시적 sort,
minPA 또는 minBF, page/limit다. playerId는 SQL 집계 전에 적용하며 group=team과 함께 요청하면
400으로 거부한다. 전체 팀 기록처럼 보이는 선수 부분 합계를 만들지 않는다.
minPA/minBF는 탐색 기준이며 공식 규정타석/규정이닝 충족으로 표시하지 않는다.
기본값은 순위 필터 0으로 표본을 보여주고 UI에서 선택한 기준을 URL에 보존한다.

리그 화면은 선수/팀·당시 팀을 포함한 주요 지표 10열을 기본으로 표시한다. `전체 세부 기록`을
켜면 같은 응답의 모든 열을 보여 주며 조회·정렬·페이지·최소 표본을 변경하거나 추가 요청하지
않는다. 투구 요약에도 ERA 확인 경기 수를 표시하며 미확정 ERA를 확인 경기 ERA로 대체하지 않는다.
리그 성적 표는 `summary`, `full`의 명시적 표시 범위를 사용한다.

선수별 `/analysis/player-statistics`는 투수·타자 분석의 **기본 기록** 탭이다. 선택한 선수의
수집 경기 성적을 연도별로 표시한다. 상황별 투구 조건은 적용하지 않는다.
공개 기록과의 대조는 [별도 조사](../2026-09-23-public-records-audit.md)로 정리하며 화면에 외부
비교나 자동 교정 경로를 추가하지 않는다.

## 구현 순서

1. [x] `contracts/player-statistics.ts`에 두 명시적 query/response와 지표별 분모 추가.
2. [x] `persistence/player-statistics-repository.ts`에 game-grain 집계 두 개와 팀 분리 집계 구현.
3. [x] 기존 시즌 view와 조건 없는 정상 표본의 결과를 대조하고 ER 누락은 의도된 차이로 테스트.
4. [x] `server/routes/player-statistics.ts`, `web/pages/player-statistics-page.tsx`와 API client 연결.
5. [x] 선수 선택에서 기간 추이·구질/타자 프로필·근거 경기 목록으로 이동.

## 검증과 완료 조건

partial PA, 자동 판정, 볼넷 중 투수 교체, 2스트라이크 대타, 이적, 동명이인, ER 누락,
0아웃 등판을 포함한다. 선수 합계와 팀 합계는 같은 scope에서 일치해야 하며 실제 투구 수와
공식 PA/BF를 서로 대체하지 않는다. 정렬 동률은 identity로 안정적으로 처리한다.
DB integration에서 PA/pitch join 없이 집계 보존을 검증하고 API/UI에서 0과 null을 구분하면 완료한다.

## 선수 기본 기록의 연도별 성적

`GET /api/v2/analysis/statistics/player-seasons`는 `player` identity와 경기 종류를 받아
타격·투구를 한 읽기 전용 snapshot에서 조회한다. 기존 제공자 ID 링크는 `sourceRole`과 함께
해당 역할을 요청할 수 있다. 날짜 조건에는 시즌을 함께 지정한다. 날짜 없는 화면은 경기 종류에
해당하는 수집 시즌을 최신순으로 보여 준다.

시즌 중 이적한 선수도 지표별 분자·분모를 같은 시즌 안에서 합해 연도당 한 행을 표시한다.
팀 열에는 해당 시즌의 소속팀 이름을 함께 표시한다. 경기 수는 해당 기록이 생성된 수집 경기를
세므로 공식 출전 경기 수와 다를 수 있다. OPS는 반올림 전 출루율과 장타율의 합이다.
이닝은 정수 아웃 수에서 표시한다. 자책점 미확인 경기가 있으면 시즌 ERA를 —로 표시하고
확인 경기 수를 함께 제공한다.

선수 머리글의 `경기 종류·기간`에서 적용 범위를 확인하고 변경한다. 좁은 화면에서는 연도
열을 고정하고 표만 가로로 스크롤한다. 경기별 투수 화면의 심화 분석 링크는 등판 표 위에 있다.

## 경기별·상황별·리그 비교

- `/api/v2/analysis/statistics/player-games`는 선택한 역할의 현재 봉인 경기 기록을 경기 ID와
  revision별로 합산한다. 같은 날 더블헤더도 각 한 행으로 표시한다. 날짜가 같으면 경기 ID로
  정렬한다. 재생에서 돌아오면 원래 조회 조건으로 복귀한다.
- `/api/v2/analysis/statistics/player-splits`는 완료 타석의 공식 PA 또는 BF만 센다. 홈·원정은
  선수 역할과 초·말로 판정한다. 상대 손은 타석을 끝낸 상대의 확인된 투구 손 또는 타석 좌우를
  사용한다. 실제 타석 방향을 확인할 수 없는 양타 및 미확인 값은 미확인 행에 남긴다.
- 득점권은 봉인된 타석 결과 play 직전 2루 또는 3루의 주자 유무로 나눈다. 타석 도중 독립
  주자 이동은 앞선 play에 반영된다. 이 기준으로 집계한 수치의 KBO 상황별 표와 세부 집계 일치는
  별도 대조가 필요하다. [KBO 주자상황별 표](https://www.koreabaseball.com/Record/Player/HitterDetail/Situation.aspx?playerId=56034)
- `countFor`는 위 표본 중 선택한 한 행을 마지막 기록 투구 직전 볼·스트라이크로 나눈다.
  유효한 카운트가 없으면 미확인에 넣는다. 상세와 표 전체는 같은 읽기 전용 snapshot에서 조회한다.
- `/api/v2/analysis/statistics/player-league`는 선택 시즌·경기 종류·기간의 선수 기록과 리그 전체를
  같은 snapshot에서 조회한다. 리그 분자와 분모를 각각 합산하며 순위 화면의 최소 표본과 페이지는
  평균에 적용하지 않는다. 투구 비교는 자책점 확인 이닝을 ERA와 함께 표시한다.
- `/api/v2/analysis/matchups/direct`는 투수와 타자가 직접 상대했던 실제 투구와 공식 책임 기준
  완료 타석을 각각 제공한다. 맞대결 화면에서 타격 합계를 먼저 보고, 유사 조건 비교를 열면
  `/api/v2/analysis/matchups`를 따로 조회한다. 비교 안의 두 투구 표본은 같은 snapshot에서 읽는다.
- `/api/v2/analysis/matchups/opponents`는 현재 범위의 실제 투구와 책임 기준 공식 완료 타석을
  각각 집계해 직접 상대를 표시한다. 검색 후보에 시즌의 봉인된 로스터에서 확인한 구단과 선수 ID를
  표시한다. 같은 이름은 구단과 ID로 구분하고, 직접 상대 기록이 있는 후보부터 보여 준다.
