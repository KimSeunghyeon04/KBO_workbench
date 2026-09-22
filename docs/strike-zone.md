# 신장 기반 스트라이크존

분석 SQL, 타자 선구안과 재생은 **타자 키와 경기 시즌만** 존 경계의 입력으로 사용한다.
제공자 `topSz/bottomSz`는 정상이어도 사용하지 않는다. 같은 경기 원문, 같은 시즌의 동일 선수 ID,
명시적으로 검토한 공식 프로필 순으로 키를 보완한다. 유효한 근거가 없거나 값이 충돌하면 null이다.
트래킹 존이나 평균 키로 대체하지 않는다.

| 경기 시즌 | 규칙 연도 | 상단 / 신장 | 하단 / 신장 | 좌우 전체 폭 |
| --------- | --------- | ----------- | ----------- | ------------ |
| 1982–2024 | 2024      | 56.35%      | 27.64%      | 47.18cm      |
| 2025–2026 | 2025      | 55.75%      | 27.04%      | 47.18cm      |

2024 이전에 2024 규칙을 적용하는 것은 사용자가 정한 분석 기준이다. 당시 심판 존의 재현이 아니다.
2027 이후는 기준을 명시적으로 추가하기 전까지 계산 불가다.
근거: [KBO 2024](https://www.koreabaseball.com/MediaNews/Notice/View.aspx?bdSe=9984),
[KBO 2025 변경](https://www.koreabaseball.com/MediaNews/Notice/View.aspx?bdSe=10321),
[KBO 2026](https://www.koreabaseball.com/Kbo/League/GameManage2026.aspx).

키는 해당 경기의 네이버 원문에서 추출한다. `previewData`의 양 팀 선발·후보 명단과
`textRelayData`의 양 팀 타자·투수 명단과 `textRelays[].textOptions[]`의
`batterRecord/pitcherRecord`에서 `playerCode/pcode`와 `height`를 읽는다.
`"185.0"`처럼 소수 표기된 정수 cm도 허용하며, 100~250cm 밖의 값·비정수·비수치는 계산에 쓰지 않는다.
빈 키는 유효한 관측을 덮지 않고, 동일 경기·선수의 유효한 값이 충돌하면 null이다.
같은 경기에서 유효 값이 충돌하면 낮은 우선순위로 넘어가지 않는다. 같은 시즌의 모든 검증된
관측값이 일치할 때만 다른 경기에서 보완한다. 이 단계의 충돌도 공식 프로필로 덮지 않는다.
다른 시즌의 네이버 키, 이름만 같은 선수, KBO 등록정보, 트래킹 존으로 대체하지 않는다.
신장(cm) × 비율 ÷ 30.48로 피트 경계를 계산한다.

## 선수 키의 DB 저장과 기존 경기 반영

`0008_naver_player_heights`는 `registry.game_height_bundles`와
`registry.game_player_height_observations`에 게임 ID·원문 해시·선수 ID·키·원문 값·endpoint·경로를
typed 컬럼으로 저장한다. 같은 관측의 반복은 결정적 첫 출처 한 건으로 보존한다.
원문 gzip, endpoint hash, canonical JSON, bundle hash 검증과 추출은 공용 worker에서 수행한다.
적재 후 다시 읽은 dataset hash를 확인하고 봉인하며, DB trigger로 수정·추가·삭제를 막는다.

`0009_player_height_supplements`는 원문 추출 버전 2를 추가한다. 버전 1의 봉인 관측과 hash는
유지하고 확장한 추출 결과를 버전 2로 추가한다. `registry.official_player_heights`에는 검토한
공식 프로필의 적용 시즌·선수 ID·이름·생일·원래 수치/단위·정수 cm·URL·외부 ID·확인일·근거 hash를
저장한다. 인치 자료는 2.54를 곱한 뒤 정수 cm로 반올림한다. 공식 프로필은 해당 KBO 시즌에 실제로
측정한 신장이라는 주장이 아니라, 해당 시즌에 사용하기로 명시적으로 채택한 보완 근거다.

`registry.game_player_height_choices`는 경기 ID·원문 해시·선수 ID별 채택값과 출처를 한 번 확정한다.
같은 경기/시즌 근거는 정확한 관측 행을 FK로 참조하고, 공식 근거는 시즌·선수 ID로 참조한다.
기존 선택과 공식 근거는 DB trigger가 수정·삭제를 차단한다. 새 원문이나 프로필 조회 결과가 들어와도
이미 채택한 값을 자동 변경하지 않는다. 조회 중 외부 요청이나 다른 경기 fallback 계산은 없다.

`0010_player_height_lookup`는 실제 투구의 타자·revision별로 한 행만 조회하고 확정 키가 없는 경우에만
원문 관측을 집계한다. 대량 시즌 조회에서 원문 전체를 반복 스캔하지 않으며 키 선택 규칙은 동일하다.

새 경기의 웹 가져오기는 키·채택값·경기 facts를 한 트랜잭션에서 저장한다. 기존 봉인 경기의 키는
명시적인 `pnpm maintenance:import-player-heights`로 원문 검증과 추출을 모두 마친 뒤 보완한다.
한 원문이라도 실패하면 그 실행의 보완 선택 단계는 진행하지 않고 재실행으로 이어간다.
`--dry-run`은 원문과 입력 파일만 검증하고 DB에 기록하거나 선택을 확정하지 않는다.
완료된 원문은 건너뛰므로 중단 후 재실행할 수 있고, 원문 누락·손상은 경기별로 보고한다.
외부 재수집과 경기 원장·봉인 revision·기존 hash 변경은 하지 않는다.
원문을 포함하지 않는 이전 V3 전송 경로로 가져온 경기도 원문 복원 후 이 명령을 사용한다.

검토한 외부 프로필은 파일을 명시해서 가져온다. 같은 시즌·선수의 다른 내용은 덮어쓰지 않고 거부한다.

```powershell
pnpm maintenance:import-player-heights --profiles database/reference/player-heights-20260916.json
```

이 파일은 페레즈(2021) 183cm, 스티븐슨(2025) 180cm, 보어(2021) 193cm, 화이트(2020) 180cm를
MLB/NPB 공식 프로필로 보완한다. URL과 원 수치는 파일에 고정하며 실행 시 사이트를 재조회하지 않는다.

분석과 재생은 `analytics.game_batter_heights`를 통해 해당 revision의 원문 해시와 선수 ID로
DB 키를 읽는다. 분석 요청 때 원문 파일을 다시 열지 않는다. registry의 KBO 시즌 등록자료는
선수 소속용 기존 기능으로 유지되며, 스트라이크존의 키 공급원이 아니다.

`game-core.resolveBatterStrikeZone`가 순수 계산을 소유하며 SQL 함수와 일치하는지 회귀 검증한다.
실제 투구 높이는 기존처럼 `y(t)=crossPlateY`의 교차 시각에서 구한 `z(t)`다. 분석의 단일 평면,
공 중심 기준 안팎 분류는 ABS의 중간면·끝면 전체 판정 장비를 재현한 결과가 아니다.

## 제공자 존 폐기

- collection은 새 tracking candidate에 `topSz/bottomSz`를 매핑하지 않는다.
- compiler는 기존 두 필드를 유효성 검사와 중복 판별에서 제외한다.
- migration `0007_batter_height_strike_zone`은 해당 DB CHECK만 제거한다. 다른 적재 검증과
  sealed 불변성, projection 3/4의 읽기·해시는 유지한다.
- 기존 문서와 봉인 DB의 필드는 이전 해시 검증용 증거로만 읽는다. 분석 view의 기존 `top_sz/bottom_sz`
  열은 항상 null이고, 새 `batter_height_cm`만 신장 계산으로 전달한다.
- replay 응답은 두 필드를 제거하고 별도 `strikeZone`에 규칙 연도·키·계산 경계를 담는다.
  frame hash는 새 응답을 포함하므로 기존 cursor 대신 새 manifest부터 다운로드한다.
- 수집 원본과 기존 사용자 제외 결정은 자동 변경하지 않는다. 존 오류 때문에 제외했던 궤적은
  원래 실제 투구에 명시적으로 다시 연결해야 분석에 포함된다.

분석 sourceHash에는 경기 revision뿐 아니라 적용 정책과 정렬된 경기·선수별 실제 적용 키도 포함한다.
따라서 기존 경기의 키가 보충되면 선구안 캐시는 무효화된다. 평균 포심 궤적 캐시는 키에 의존하지 않는다.
재생은 manifest 다운로드 시 키를 읽고 해당 다운로드의 frame hash와 페이지를 함께 고정한다.

회귀 검증은 제공자 존 변경·역전·누락에 대한 결과 불변성, 키 누락 시 fallback 부재,
연도·신장별 TypeScript/SQL 일치, 기존 sealed hash 보존과 신규 적재 성공을 확인한다.
