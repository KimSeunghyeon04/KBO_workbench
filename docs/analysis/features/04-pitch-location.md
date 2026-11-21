# A04. 투수 코스와 결정구

선행 조건: A01, 기존 A07의 실제 코스 정의. A07의 새 화면 개발 완료는 필요하지 않다.

## 첫 범위

투수·구종·카운트·타석 좌우별 5×5 코스 지도와 사용률·스윙률·헛스윙률·루킹 비율·CSW를 제공한다.
코스는 관측된 도착 위치이며 포수 목표 대비 제구력으로 표시하지 않는다.
첫 구현에서는 새로운 ‘모서리 공’ 임계값이나 종합 제구 점수를 만들지 않는다.

## 계산 정의

- 실제 코스/존은 기존 선구안의 source-plane와 신장 정책을 사용한다. 중간면 구질 보정을 적용하지 않는다.
- 전체 투구 결과 표는 actual 전체, 코스 지도는 좌표·존 판정 가능한 표본이다. 두 표의 분모를 구분한다.
- Swing%=swings/pitches, Whiff%=whiffs/swings, SwStr%=whiffs/pitches,
  Called-strike%=calledStrikes/pitches, CSW%=csw/pitches다.
- 존 의존 지표는 zone-known 표본만 사용한다. 일반 실제 투구 표와 A07의 상황 제외 표본이 다르면
  그대로 명시하며 ‘선구안과 동일 표본’ 모드를 별도로 선택한다.
- 결정구 지표의 첫 정의는 ‘2스트라이크 실제 투구 중 타석을 삼진으로 끝낸 투구 비율’이다.
  compiler의 terminal pitch 연결로 1건만 귀속한다. 자동 스트라이크로 끝난 삼진은 이 분자에 넣지 않고
  별도 수로 표시한다. 규칙을 중계 문구에서 다시 추론하지 않는다.
- 인플레이 안타 비율은 종결 인플레이 타구 결과가 연결된 투구만 분모로 삼고 타율로 부르지 않는다.

## 구현 순서

1. [x] 기존 `game-core/batter-discipline.ts`의 순수 코스 분류에서 A04/A07이 실제 공유하는 부분만
       `pitch-location.ts`로 추출. 기존 경계·신장 누락·면 테스트 보존.
2. [x] `contracts/pitch-outcomes.ts`, `persistence/pitch-location-repository.ts`에 분모별 집계와
       terminal event/PA 연결을 추가. join 전후 투구 수 불변 검증.
3. [x] `server/routes/pitch-location.ts`: `/api/v2/analysis/pitch-location/:pitcherId` 구현.
4. [x] `web/pages/pitch-outcomes-page.tsx`의 투수 모드에 지도·표·선택 근거 연결.

첫 버전은 카운트·구종·stance별 기술 통계다. 리그 대비 조정값을 제공하려면 A07과 동일한
조건 일치와 대상 선수 제외 규칙을 별도 계약으로 확정하며 단순 raw 차이를 조정값이라 부르지 않는다.

## 검증과 완료 조건

zone 경계 포함, 바깥 무한 구간, 키 누락, 구속/구종 미상, 모든 공이 볼 또는 스윙 없는 그룹,
일반 파울·번트 파울·foul tip·자동 삼진·타석 중 선수 교체를 검증한다.
같은 scope에서 cell 합계가 지도 표본과 같고 Whiff/SwStr 분모가 구분되어야 한다.
실제 코스가 구장 보정 프로필 변경으로 이동하지 않으면 완료한다.

## 타석 방향 보완과 구종 배합 응답

투수 코스 API의 `arsenal`은 현재 조회 조건을 적용한 actual 투구를
타석 표기·사전 볼/스트라이크·원 구종으로 교차 집계한다. 구성비의 분모는 해당 타석·카운트의
실제 투구다. tracking 누락도 포함하고 구종/타석 미상을 보존한다. 투구별 관측 방향을 우선하며,
없으면 같은 경기·원문 해시·선수 ID의 프로필을 사용한다. 단일 좌타·우타 선언은 L/R로 보완하고
양타석(S)은 좌우로 나누지 않는다. 유효한 프로필 선언끼리 충돌하거나 근거가 없으면 null을 유지한다.
프로필로 타석 방향을 보완해도 좌표와 존 판정은 결측을 유지한다. 타자 응답 계약은 유지한다.

`0014_player_batting_profiles`는 collection이 원문의 `batsThrows`/`hitType`을 정규화한 관측을
별도 typed registry에 원문 값·endpoint·경로·dataset hash와 함께 봉인한다. 경기 projection 4와
기존 hash는 유지한다. 신규 웹 적재는 같은 transaction에서 프로필을 저장하며, 기존 적재 경기는
`pnpm maintenance:import-player-batting-profiles --season 2026 --dry-run`으로 검증한 뒤
`--dry-run` 없이 명시적으로 보완한다. `--game <경기 ID>`로 한 경기를 지정할 수 있으며 재실행은
이미 봉인된 같은 원문을 건너뛴다. 유지보수는 네트워크 호출이나 경기 fact 교정을 하지 않는다.
A04/A08의 배합·좌우 필터·종결 PA는 같은 유효 방향을 사용하고 source hash에도 반영한다.

Docker 운영 환경에서는 업데이트로 migration을 적용한 뒤 API 컨테이너에서 같은 명령을 실행한다.

```sh
docker compose exec api node apps/server/dist/maintenance/import-player-batting-profiles.js --season 2026 --dry-run
docker compose exec api node apps/server/dist/maintenance/import-player-batting-profiles.js --season 2026
```
