# A01. 분석 범위와 데이터 품질

선행 조건: 없음. 후속 기능 전체가 사용하는 최소 기반이며, 범용 데이터 카탈로그 제품은 만들지 않는다.

## 제공할 결과

시즌·경기 종류·기간별 경기 수, 실제 투구·완료 타석 수, 구속/구종/궤적/존/구장 보정의
사용 가능 수를 보여준다. 미분류 경기와 조회 범위를 명시하고 가능한 경우 공식 일정 대비 수집률을 제공한다.

## 데이터와 계약

- `current_game_revisions`, `current_pitches`, `current_plate_appearances`를 각각 자기 grain에서 집계한다.
  세 표를 원시 행 그대로 join해 count하지 않는다.
- 품질의 필드 존재율과 실제 계산 성공률을 별도로 반환한다. 궤적·존·보정 eligibility는 기존 함수와
  같은 규칙을 호출하며 SQL에 다른 물리 판정식을 새로 복사하지 않는다.
- 최초 API 후보: `GET /api/v2/analysis/coverage?season=2025&competition=regular`.
  응답은 조건·sourceHash·경기/투구/타석 수·서로 합산 가능한 제외 수·별도 진단 수를 가진다.
- 표본 조회는 `gameId + revision`으로 고정한다. 데이터가 없으면 empty이며 비율 null이다.

### 경기 종류 보완

먼저 기존 collection schedule/raw 증거의 명시적 경기 종류를 점검한다. 없으면 공식 일정의 작은
시즌·월 표본으로 sourceGameId 매칭을 검증한 뒤 범위를 늘린다. 날짜만으로 경기 종류를 추정하지 않는다.
제공자 ID 차이는 명시적 매핑으로 처리하고 날짜·팀·더블헤더 번호 대조가 충돌하면 unresolved로 남긴다.

제안하는 저장은 `reference` schema의 기능 전용 typed 테이블이다.

| 테이블 후보                    | 핵심 내용                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `competition_datasets`         | dataset hash, season, source URL/원문 hash, parser version, 확인 시각                                                                          |
| `game_competitions`            | dataset hash, 안정적인 source row key, 외부 경기 ID, 날짜, 양 팀 코드, 경기 번호, 경기 종류, 원천 진행 상태, 매칭 game_id(nullable), 매칭 상태 |
| `current_competition_datasets` | 시즌별 채택 dataset hash                                                                                                                       |

원본 응답은 파일 증거로 보존하고 DB에는 typed 컬럼만 둔다. 공식 취소 경기까지 수집 완료 분모에
포함하지 않는다. 동일 dataset/game의 중복·상충과 한 경기의 다중 채택을 거부한다. dataset은 불변,
현재 포인터는 검증된 새 dataset 채택 transaction에서만 바꾼다. 경기 facts와 별도로 갱신한다.
미분류 포함 탐색과 정규시즌 비교를 구분하고 sourceHash에 적용 dataset과 범위를 포함한다.

## 구현 위치와 순서

1. [x] `contracts/analysis-coverage.ts`, `persistence/analysis-coverage-repository.ts`에 품질 응답과 집계 추가.
2. [x] `server/routes/analysis-coverage.ts`, `web/pages/analysis-coverage-page.tsx`로 조회·표본 표시 연결.
3. [x] 경기 분류 취득이 필요할 때만 `collection/kbo-schedule.ts` adapter와 전용 reference repository 추가.
4. [x] maintenance 명령에 dry-run, 전체 검증 후 채택, 재실행·충돌 보고를 구현. 읽기 API에서 취득 금지.
5. [x] 두 실제 소비자 A03/A07에 범위 조회를 적용하면서 작은 scope 계약/SQL 조각만 공유.
6. [x] 기존 분석의 기준·보정 입력까지 선택 경기 종류가 전달되는지 확인하고 scope별 cache key 적용.

## 검증과 완료 조건

- actual/비실제 투구, tracking 누락·중복 후보, 잘못된 계수, 키 없음, 미지원 구장을 섞은 fixture로
  필드 존재와 계산 성공 수가 달라짐을 검증한다.
- 날짜 양 끝 포함, DB session timezone 무관한 경기 날짜, 더블헤더·취소·포스트시즌·ID 충돌을 검증한다.
- current revision 갱신과 classification dataset 교체가 같은 응답 snapshot에 섞이지 않아야 한다.
- 부분 취득·파싱 실패가 현재 dataset 포인터를 바꾸지 않아야 한다. 테스트는 실제 KBO 호출 없이 수행한다.
- 모든 화면 수가 근거 경기와 일치하고, 미분류를 0 또는 정규시즌으로 바꾸지 않으면 완료한다.

조회 개선: 전체 투구를 집계하기 전에 같은 snapshot에서 경기 revision·분류와 유효 신장을 읽어
캐시 키를 검증한다. 신장 보충은 sealed 경기 해시를 바꾸지 않아도 캐시를 무효화한다. 캐시가 없을
때만 경기별 투구/PA 집계와 궤적 입력을 읽으며, 집계·계산·표시의 기존 분모와 응답 해시는 유지한다.

품질 요약은 시즌·경기 종류별 경기 집계를 `analysis/coverage/`에 저장한다. 기간 필터는 요약만
집계하며 GET은 미준비 시 202를 반환하고 서버에서 준비한다. 한 작업/대기 16개의 제한과
실패 후 재시도, writer lock·원자 저장·해시 검증을 적용한다. [상세 계약과 검증](../2026-09-21-coverage-preparation.md)을 따른다.
