# 선수별 기본 기록

2026-09-23. 선수 분석에서 일반적인 야구 기록을 확인할 수 있도록 기본 기록 탭을 추가했다.
공개 기록과의 차이 확인은 사용자 요청에 따라 [별도 표본 조사](../analysis/2026-09-23-public-records-audit.md)로
정리했다. 비교 화면·외부 기록 수집 job·자동 데이터 수정 기능은 추가하지 않았다.

## 화면과 조회

`/analysis/player-statistics`는 투수와 타자 공통 경로다. `playerRole`과 `pitcher`/`batter`로
선수를 선택한다. 기존 선수 메뉴 첫 항목에 **기본 기록**을 추가하고 기존 목록의 최초 목적지는
코스·결정구/반응·성적으로 유지한다. 시즌·경기 종류·기간은 다른 분석으로 이동할 때 보존한다.

타자는 G·PA·AB·H·2B·3B·HR·BB/IBB·HBP·SO·R·AVG·OBP·SLG·OPS, 투수는 G·BF·IP·H·R·
BB/IBB·HBP·SO·실제 투구수·ERA와 ER 확인 범위를 표시한다. 이닝은 정수 아웃 수를 ⅓·⅔로
표현한다. 제공되지 않은 ER은 0으로 채우지 않고 전체 ERA와 확인 경기 ERA를 구분한다.
기존 계약에 없는 승·패·세이브·홀드 등을 브라우저에서 추정하지 않는다.

기본 기록은 공통 경기 범위의 합계다. 구종·카운트·코스 등 투구 상황 필터는 전달하지 않는다.
명시된 선수는 기간이나 시즌을 바꿔도 유지하고 기록이 없으면 빈 결과를 표시한다. 시즌 변경은
이전 시즌 날짜 조건을 제거한다. 선수 ID가 없는 첫 진입에서만 catalog 첫 선수를 사용하며,
빈 catalog에서 리그 전체 성적을 대신 조회하지 않는다.

선수 목록은 기존 실제 투구 catalog를 재사용한다. 실제 투구가 없는 대주자·수비 전용 선수 등의
발견 범위를 이번 작업에서 넓히지는 않았다. 명시 ID는 catalog에 없어도 통계 API에 전달한다.
자료 없음·잘못된 조건·조회 실패를 구분하고 실패한 조회는 다시 시도할 수 있다.

## 책임과 성능

- `PlayerBasicStatisticsPage`: URL·조회 상태·필터와 선수별 기록 표시.
- `player-statistics-tables`: 기존 리그 성적 페이지와 재사용하는 명시적인 타격/투구 표. 수치
  계산은 하지 않으며 두 용도에 맞는 열과 숫자 형식만 선택한다.
- `player-statistics-client`: TypeBox 응답 decode 뒤 요청 query·공통 범위·page/limit/group과
  선택된 선수 ID의 일치를 확인한다.
- `PlayerStatisticsRepository`: 기존 player-game grain·읽기 전용 snapshot에서 `playerId`를 SQL
  집계 전에 적용한다. 다른 선수·시즌·기간의 기록을 섞거나 전체 시즌 순위 페이지를 순회하지 않는다.

API의 선택적 `playerId`는 길이 1–200 문자열이다. `group=team`과 동시 지정하면 DB 접속 전에
`InvalidAnalysisScopeError`를 내며 기존 중앙 HTTP handler가 400으로 변환한다. 무필터 조회의
sourceHash 입력은 보존하고 선수 필터가 있을 때만 해당 ID를 추가한다. 이적 선수는 당시 팀별
행을 유지하며 팀별 비율을 평균하거나 선수 합계를 브라우저에 새로 계산하지 않는다.

화면은 `group=player`, page 1, limit 200, 선수 ID로 한 번 요청한다. 상한을 넘은 경우에는 일부
표시임을 명시한다. 행 이름은 가로 스크롤 중 고정하고 작은 화면에서는 표 안에서 스크롤한다.
신규 generic 표 framework·통계 계산 계층·DB migration은 없다.

독립 리뷰에서 공통 `competition=` 빈 문자열이 catalog의 all 기본값과 통계의 regular 기본값을
갈라놓을 수 있음을 발견했다. 공통 scope decoder가 명시적인 빈 경기 종류를 거부하도록 수정하고
통계·catalog 요청이 모두 중단되는 회귀를 추가했다. 키 자체가 없는 기존 URL 기본값은 유지한다.

## 검증

실제 손주영 2025 투구 기록과 구자욱 2025 타격 기록을 읽기 전용 API로 표시해 확인했다. 새
조회 route는 운영 서버 재배포 없이 별도 임시 컨테이너에서 실행했고 모든 연결에
`default_transaction_read_only=on`을 적용했다. 로컬 Vite의 통계 요청만 해당 미리보기를 사용한다.
390px에서도 문서 가로 넘침 없이 표 내부 스크롤을 유지했다.

PostgreSQL 통합 테스트 76개와 격리 Compose E2E가 통과했다. E2E는 투수·타자 모두 기본 기록
진입과 다른 분석 복귀, 선수·범위 유지, 역할에 맞는 표 및 모바일 크기를 검증한다. 기존 운영
화면과 여섯 모델의 게시·멱등성·재시작 보존 여정도 통과했다. 테스트 프로젝트는
`kbo-stage6-14304-dc452c3e`이며 정확한 임시 컨테이너·네트워크·볼륨을 정리했다.

최종 전체 단위 테스트는 185개 파일, 1,027개 테스트가 통과했다. 기본 실행의 PostgreSQL 테스트
76개는 DSN이 없어 skip되지만 위 격리 PostgreSQL 실행에서 모두 통과했다. lint·format·typecheck·
schema check·build와 `git diff --check`도 통과했다. 공통 빈 경기 종류 회귀를 추가한 뒤 전체
단위 테스트와 빌드를 다시 확인했다. 로그는 로컬
`analysis/commit-preparation/20260923-basic-records/`에 보존했다.
