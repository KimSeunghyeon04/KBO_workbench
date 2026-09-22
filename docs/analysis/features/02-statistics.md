# A02. 선수·팀 성적 비교

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

`GET /api/v2/analysis/statistics/batting`과 `/pitching`을 별도 strict 계약으로 제안한다.
query는 season/date/competition, group=player|team, 명시적 sort, minPA 또는 minBF, page/limit다.
minPA/minBF는 탐색 기준이며 공식 규정타석/규정이닝 충족으로 표시하지 않는다.
기본값은 순위 필터 0으로 표본을 보여주고 UI에서 선택한 기준을 URL에 보존한다.

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
