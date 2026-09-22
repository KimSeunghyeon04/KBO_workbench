# KBO Workbench Web

스트라이크존은 타자 키로 계산한다. 2024년까지는 2024 규칙, 2025·2026년은 2025 규칙을 사용하며
트래킹 존으로 대체하지 않는다. 키가 없으면 계산 불가다. [정책·구현·검증](docs/strike-zone.md)을 따른다.
키는 네이버 명단·중계 내부 선수 기록에서 추출하고, 같은 시즌의 동일 선수 ID와 검토한 공식 프로필로
보완한다. 채택값과 출처를 DB에 고정하며 신규 경기 가져오기 때 함께 저장한다. 기존 경기는
`pnpm maintenance:import-player-heights --profiles database/reference/player-heights-20260916.json`으로
보완한다. 이미 확정한 값은 자동 변경하지 않는다.

주자 이동의 책임 투수는 `자동` 문구 대신 현재 계산된 선수 이름으로 표시한다. 이동을 수정해 아직
계산하지 않은 경우에는 반영 후 확인하도록 표시한다. 포스 병살에서도 이전 투수의 책임 주자를
대체한 후속 주자에게 실점 책임을 승계한다.

수집한 행도 `중계 문구`를 수정할 수 있다. 수정 문구는 원장과 재생에 반영하고 최초 원문은 근거로
보존한다. 문구 수정만으로 선수·판정·주자 이동이 바뀌지는 않는다.

원문 관측이 잘못된 행은 수정 창의 `관측값 수정 (검증용)`에서 볼·스트라이크·아웃·점수·베이스를
교정할 수 있다. 원본은 보존하고 보정 원장의 비교값만 변경하며, 전체 검증과 undo/redo를 적용한다.
주자 이동 편집에서는 직접 선택한 주자와 출발 베이스를 유지해 같은 플레이의 연속 진루를 입력할 수
있다. 자동 추천은 비어 있거나 자동 지정 상태인 필드에만 적용한다.

Naver KBO 문자중계를 수집·정리·보정하고, 검증된 원장을 PostgreSQL의 분석·재생용 구조로
컴파일하는 개인용 로컬 웹 워크벤치다.

대량 데이터에서는 검증된 목록·원문·재생 조회를 용량 제한 안에서 재사용하고, DB 목록은 SQL 페이지로
읽는다. 시작 중에는 무결성 검사가 끝날 때까지 준비 응답을 보내며 화면 조회는 자동 재시도한다.
재생 화면은 DB 경기만 조회한다. 보정 명령·수집 정규화·적재 전후 컴파일은 최대 2개 CPU worker에서
실행하며, 기록정정은 같은 원장과 공지의 검증 결과를 제한된 용량에서 재사용한다. 투수 분석은 매번
시즌 revision을 확인하고 같은 snapshot의 표본 조회·계산을 공유한다. 적재 이력은 검증을 유지하면서
최대 16개 파일씩 읽고, 목록 정렬 순서를 재사용한다.
원문 최초 읽기·무결성 검사, 보정 응답 준비와 DB projection·hash 계산도 같은 제한된 worker에서
처리한다. 검증된 원본은 worker마다 최대 16MiB/4건씩 보관하고 선택한 행의 근거만 API로 전달한다.
분석 chunk는 누적 복사 없이 합치며, 수집 이력은 검증한 정렬 결과를 32MiB/20,000건까지
재사용하고 변경 시 갱신한다. 이력 상세는 현재 페이지의 경기만 조회한다. 상태 화면은 최대 500ms
동안 검사 결과를 공유하며 준비 상태 점검은 매번 새로 수행한다.
교정 저장·작업 사본 닫기·변경 없는 화면 이탈은 서버 세션도 정리한다. 미저장 작업은 유지하며 같은
탭에서 보정 화면으로 돌아오면 다시 연다. 서버 재시작을 넘기는 영구 저장은 기존 저장 명령으로 한다.

가장 중요한 경계는 다음과 같다.

```text
Naver 응답 -> immutable source bundle -> StagingGameDocumentV2 평면 원장
             -> tracking/원장 보정 -> 전체 compiler 검증
             -> versioned current(ready/quarantine/source_failure) -> V3 catalog + sealed PostgreSQL revision
             -> pitch/PA/play/runner/player-game 분석 fact와 replay

KBO Register/Trade -> gzip 원문 증거 -> registry season revision
                   -> 공식 player identity + 등록/소속 stint

KBO 기록정정현황 -> gzip 원문 증거 -> record_correction season revision
                 -> 경기/PA 후보 평가 -> correction batch 수동 승인
```

- JSON은 최종 경기 상태가 아니라 원천 중계를 정리하는 작업 원장이다.
- 원장의 이벤트는 Naver 중계 행과 1:1로 대응한다. 타석 결과와 주자 이동은 서로 다른 행이다.
- 아웃·주자·점수·타석·기록은 JSON에 중복 저장하지 않고 compiler가 계산한다.
- `sourcePitchId`는 유일하지 않은 출처 힌트다. tracking candidate의 identity는 결정론적
  `trackingId`이며 실제 pitch와의 관계는 교정 가능한 0..1이다.
- `sourcePitchOrdinal`은 Naver `ballcount` 원천값이다. 실제 PA 투구 순번은 compiler의 pitch fact가
  계산하며 두 값을 동일하다고 가정하지 않는다.
- 차단 finding이 없는 staging 원장만 새 append-only revision으로 적재한다.
- DB 적재 뒤 재생과 분석은 pitch·PA·play·movement·player-game fact를 사용한다.
- seal된 DB fact는 직접 수정하지 않는다. current revision을 draft로 reopen해 교정하고 다음 revision을
  적재한다.

## 투구 움직임 분석

상단의 `데이터 관리`와 `분석`으로 작업 영역을 전환한다. 수집·보정·기록정정·DB·설정은 데이터 관리에,
투구 움직임과 경기 재생은 분석에 있다. 현재 탭에서 영역별 마지막 주소와 선택 조건을 기억한다.

`/analysis/pitch-shape`에서 2020–2025년의 시즌 평균 포심이 도착하는 순간을 기준으로 투수의 공을
비교한다. 각 시즌의 `직구`를 포심 집단으로 사용하며, 좌우·높이·플레이트까지 거리를 회전 가능한
3D 산점도에 표시한다. 색상은 `중계 표기 기준`과 `클러스터링 기준`으로 전환한다. 클러스터는
3D GMM이며 유효 투구의 중계 구종 수를 기본 군집 수로 사용한다. 군집 수를 선택하면 즉시
재계산하고 기본값으로 복원할 수 있다. 희소 구종도 기본 개수에 포함하며 구종 미상은 개수에서만
제외한다. 각 공은 좌표로 배정하고, 설정한 성분 수와 실제 배정 군집 수를 구분한다.
투수·시즌을 바꾸면 군집 수는 새 대상의 기본값으로 돌아가며, 표시 필터는 계산에 영향을 주지 않는다.
시즌 기준은 `.data/analysis/pitch-reference/`에 저장해 서버 재시작 뒤에도 재사용하며,
해당 시즌의 current revision 또는 궤적 모델 버전이 달라질 때 다시 계산한다.
투구 움직임은 플레이트 중간면을 기준으로 통일하고, 각 경기 이전 84일·반감기 7일의 일별 구장
편향을 평균 포심과 개별 투구에 적용한다. 계수는 `.data/analysis/pitch-calibration/`에 보관하며
새 데이터가 들어온 뒤 첫 분석 요청에서 자동 갱신한다. 자료가 부족한 날짜와 미지원 구장은
미보정으로 표시한다. 원천 관측과 타자 선구안의 도착 코스는 보존한다.
GMM은 서버 worker에서 최대 2개씩 계산하고 sourceHash·투수·군집 수·모델 설정별 결과를 최대
32개까지 메모리에 재사용한다. 군집 수를 바꿔도 시점·확대와 선택한 공은 유지한다.
점 선택으로 중계 구종·클러스터·위치·시간 차이와 외삽 여부를 확인한다. 드래그·슬라이더 회전,
확대, 정면 보기, 축별 확대/실제 길이 비율을 지원한다. 기준 표본 수와 제외 건수도 표시한다.
시즌 포심의 중앙 50%·90%를 포함하는 3D 타원체를 함께 표시하며 켜기/끄기를 지원한다.
구종·군집별 평균 위치·도착 시간차와 표준편차, 포심 90% 영역 밖 비율, 헛스윙/스윙 수를 비교한다.
포심 분포 안팎의 헛스윙률은 전체 유효 투구의 관측값이며 코스·카운트·타자 좌우를 보정하지 않는다.
기준 분포는 구장 보정 해시를 포함한 modelVersion 2/referenceVersion 2 캐시에 저장하며 이전 파일을 보존한다.
계산 정의와 데이터 범위는 [투구 움직임 분석](docs/pitch-shape-analysis.md)에 정리되어 있다.

## 분석 기능 확장

품질·성적·투수 코스/변화/배합/운용·타자 프로필·매치업·주루·구장 환경 화면을 분석 메뉴에서
선택할 수 있다. 기존 구질/선구안은 수집 경기 전체가 기본이며 새 통계는 확인된 정규시즌이
기본이다. 기간·경기 종류와 지표별 분모를 확인하고 근거 경기의 정확한 revision으로 재생한다.

RE24·카운트 기대득점·승리확률은 재생 화면의 접이식 패널, 구종 기대 효과는 투구 움직임
화면의 별도 패널로 제공한다. 준비된 모델이 없거나 원천이 바뀌면 미준비 상태이며 조회 중
전체 학습을 실행하지 않는다. `/analysis/models`의 **분석 모델 관리**에서 여섯 모델의 최신 여부와
검증 채택 수를 확인하고 필요한 모델만 갱신하거나 전체 재학습·중단할 수 있다. 자동 갱신을 켜면
6시간마다 변경을 확인한다(기본 꺼짐). 학습은 별도 worker에서 하나씩 실행하고 기존 writer가
검증된 파일을 공개한다. 2020–2025 적용 시즌을 선택하며, 선행 학습과 두 검증 시즌을 확보할 수 있는
2023–2025 모델을 학습한다. 승리확률은 지원 규정 이력이 충분한 2025만 가능하다. 이력 부족 시즌은
이유를 표시하고 관측 통계를 유지한다. 자동 갱신은 시즌별로 켜며 전체 학습은 순차 실행한다.
[모델 운영 설계](docs/analysis/model-management.md)에 의존 순서·복구·조회 검증을 설명했다.
오프라인 CLI를 직접 실행할 때는 writer를 종료한 운영 시간에 다음 명령을 사용한다.
먼저 공식 경기 종류 자료를 검증·채택해야 정규시즌 학습 표본이 생긴다.

```powershell
pnpm analysis:sync-competition --season 2025 --dry-run
pnpm analysis:train-run-expectancy --through 2024 --dry-run
pnpm analysis:train-count-expectancy --through 2024 --dry-run
pnpm analysis:train-win-probability --through 2024 --dry-run
pnpm analysis:train-pitch-quality --through 2024 --dry-run
pnpm analysis:train-matchup --through 2024 --dry-run
pnpm analysis:train-park-environment --through 2024 --dry-run
```

분류는 필요한 각 시즌에 대해 실행한다. `--dry-run`은 채택/파일 공개를 하지 않는다. 저장은
해당 인자를 빼고 실행하며 모델·원천 manifest를 workspace `analysis/`에 hash로 보존한다.
모형 선택과 평가를 분리하고 기준 미달의 새 기대 확률/구장 조정값은 공개하지 않는다.
2025 승리확률은 과거 정상 종료 경기를 11회 종료 기준으로 재구성해 학습한다. 12회로 이어진
경기는 관측된 11회말 동점에서 학습용 무승부로 처리하고 12회 상태는 제외한다. 원본은 보존한다.
날씨는 실제 시작 시각이 없어 제외했다. 자세한 정의·검증·운영 상태는 [분석 구현 문서](docs/analysis/README.md)에 있다.

매치업의 `구질 유사도·기대 반응` 패널은 고정한 구질 거리의 관측 비교와 별도로 검증한 타자별
스윙·헛스윙·루킹 확률을 제공한다. `analysis:train-matchup`은 같은 원천의 구종 기대 효과 모델이
먼저 준비되어 있어야 한다. 구질 거리의 예측 개선은 검증 기준 미달이므로 탐색용으로 표시한다.
투구 움직임과 투수 변화의 `진입각 VAA/HAA` 패널은 완료 경기의 원천 궤적을 중간면에서 평가한다.
각도에는 구장 보정을 적용하지 않으며 도착 높이·가로 위치와 함께 비교한다.
정의와 검증 결과는 [매치업·진입각 확장 기록](docs/analysis/2026-09-20-matchup-angles.md)을 따른다.

투수 운용의 `조건을 맞춘 운용 비교` 패널은 휴식·최근 3/7일 투구·경기 내 투구 수·동일 타자 대면에
따른 구속·스윙·헛스윙 차이를 비교한다. 같은 투수의 구종·타석·카운트·등판 역할 조건을 맞추며
공통 표본·경기 수와 경기 단위 95% 구간을 표시한다. 표본이 부족하거나 재표집이 불안정하면
수치를 보류한다. 추가 학습 없이 패널을 펼칠 때만 계산한다. [정의와 한계](docs/analysis/features/12-pitcher-workload.md)를 참고한다.

실제 수집 자료에서 분류·학습·성능을 재현하려면 `pnpm analysis:validate`를 사용한다.
운영 DB를 읽어 새 검증 DB에 복사하고 기존 기능별 CLI를 순차 실행한다. 실행 인자·재개·정리와
측정 범위는 [실데이터 검증 절차](docs/analysis/real-data-validation.md)에 있다.
준비된 격리 DB의 전체 투수 운용 비교와 실제 HTTP 조회를 반복 점검하려면
`pnpm analysis:audit --run analysis/validation/<UUID>`를 사용한다. 2020–2025 전체 선수·시즌의
표본 보존·입력 순서 불변성을 확인하고 첫 조회·반복·동시 요청·취소 후 복구를 측정한다.
`--baseline <이전 audit 디렉터리>`로 같은 원천의 응답 hash를 대조하며, 학습이나 운영 데이터
쓰기는 수행하지 않는다. 매 실행 결과는 기존 실행 아래 새로운 `audits/<UUID>/`에 보존한다.
운영 반영 범위·백업·실제 HTTP 점검은 [운영 배포 기록](docs/analysis/production-deployment.md)에 있다.

자료 품질 화면은 검증된 경기별 요약을 저장해 기간 변경과 서버 재시작에 재사용한다.
새 자료는 준비 상태를 먼저 표시하고 완료 후 자동 갱신하며, 실패 시 **다시 준비**할 수 있다.
경기 revision·분류·신장·계산 정의가 달라지면 해당 시즌의 요약을 새로 준비한다.
[품질 요약 저장과 비동기 준비](docs/analysis/2026-09-21-coverage-preparation.md)에 계약과 검증 범위를 설명했다.

## 타자 선구안 분석

분석 메뉴의 `/analysis/batter-discipline`에서 타자·시즌·카운트·구종·타석을 선택한다. 실제 코스별
스윙 지도와, 같은 초기 위치·방향에서 시즌 평균 포심이었다고 가정한 도착 위치·시간 대비 스윙률을
나란히 본다. 예상/실제 존 안팎 네 구간, 코스 선택과 개별 투구 확인, 조건별 다른 타자 비교를 제공한다.
리그 비교는 같은 카운트·구종·타석·구속대·코스의 다른 타자 20구 이상인 조건만 사용하며 비교 가능한
표본 수를 표시한다. 종합 선구안 점수나 타자의 실제 인식 확률은 아니다. 표본과 계산 정의는
[타자 선구안 분석](docs/batter-discipline-analysis.md)을 참고한다.
기존 코스 기준의 Zone%·Swing%·Z-Swing%·Chase%와 포심 비교 가능한 공의 같은 지표를 함께 표시한다.
존 밖 공을 포심 예상 존 안팎으로 나누고, **동일한 비교 가능 투구**에서 코스 조건만 맞춘 리그와
포심 예상 존 조건까지 맞춘 리그의 스윙률·차이를 비교한다. 전체 지표는 존 판정 가능 표본 기준이며,
조건 추가에 따른 비교값 변화와 예측 정확도 향상은 구분한다. 스트라이크별·볼별 조회도 지원한다.

## 실행

1. `.env.example`을 `.env`로 복사하고 로컬 DB 암호와 data directory를 설정한다.
2. Docker Desktop을 시작한다.
3. 저장소 루트에서 실행한다.

```powershell
docker compose up -d
```

브라우저에서 <http://127.0.0.1:8080>을 연다.

상태 확인과 일반 종료는 다음 명령을 사용한다.

```powershell
docker compose ps
docker compose logs -f api
docker compose down
```

`docker compose down -v`는 PostgreSQL volume을 삭제하므로 일반 종료에 사용하지 않는다.

## 경기 수집

`/collect`의 `수집 현황`에서 날짜 범위 또는 시즌을 지정하고 **경기 확인**을 누른다. 입력 중에는
외부 요청을 보내지 않는다. 저장된 일정은 조회 시각과 함께 먼저 표시하며 **일정 새로 확인**으로
갱신한다. 일정 확인은 취소 가능한 별도 작업으로, preview·relay·record나 경기 원장을 수집하지 않는다.
여러 달은 월별, 한 달은 날짜별, 하루는 경기 목록으로 열리고 breadcrumb로 돌아갈 수 있다.
일정이 불완전한 범위의 미수집 수는 `—`다. 경기 날짜는 실제 일정·저장 요약을 사용하며 날짜를
확인할 수 없는 원천 실패는 별도로 표시한다. DB와 작업본이 함께 있으면 작업본을 대표 상태로 보여준다.

실행 영역의 대상 기간과 조건은 탐색·표시 필터와 독립적이다. 기본은 **미수집만**이며 원천 실패는
별도 재시도한다. **현재 날짜만 대상으로 설정** 같은 명시적 동작으로 대상을 좁히고, 조건에 맞는
전체 경기 선택과 페이지 간 개별 선택·제외를 지원한다. 서버에 확정한 선택 ID로 실행하므로 500경기를
넘어도 한 작업으로 처리한다(최대 50,000경기). 보정 작업본과 수집 중 바뀐 DB base는 덮어쓰지 않는다.
기존 명시적 단건 재수집 경로는 유지한다.

명시적 강우콜드 선언 뒤 투구·결과·주자 이동 없이 남은 이닝·타자·교체 표시는 안내 행으로 보존한다.
야수선택의 승계 책임은 해당 플레이에서 진루하지 않은 생존 주자에게도 적용한다.
preview에 빠진 선수는 같은 경기 박스스코어의 명시적 ID·이름·팀을 확인해 로스터에 보완한다.
선발·타순을 추정하지 않으며 보완 출처를 남긴다. ID·이름·팀 근거가 충돌하면 검토 필요로 유지한다.

경기 상세는 선택했을 때만 옆에 열며 1100px 이하에서는 목록 대신 상세를 표시한다. 검색은 선택 범위
전체를 대상으로 한다. 경기 목록과 `수집 기록`은 서버 페이지네이션을 사용한다(기본 50, 최대 200건).
URL 상태를 우선하고, 없으면 마지막 사용 기간·탐색 위치를 복원한다. 최초 방문은 한국 시간 기준 오늘이다.
수집 기록은 `.data/collection`에 보존하며 재시작 뒤에도 완료 결과와 요청 키를 유지한다. 중단 작업은
자동 재실행하지 않는다. 수집 당시 결과와 현재 저장 상태를 구분하고 DB 자동 적재·자동 수집은 하지 않는다.

- `적재 가능`: current manifest가 가리키는 strict/compile 통과 `ready` artifact
- `검토 필요`: current manifest가 가리키는 차단 finding 포함 `quarantine` artifact
- `원천 실패`: 필수 endpoint 또는 전송 자체가 실패해 원장을 만들지 못한 기록

공지·판독·휴식 같은 비상태 행도 원장에 남고, 안전하게 해석하지 못한 행은 원문과 원천 위치를
가진 `unresolved`로 남는다. 한 행의 실패 때문에 후속 중계를 버리거나 누락 결과를 합성하지 않는다.
반복·정정 여부와 관계없이 의미 있는 중계 행을 모두 원장에 남긴다. 같은 block의 동일 ID 투구와
tracking은 원천 occurrence 순서로 연결하고, 한 투구의 완전히 같은 tracking 재전송은 첫 관측을
canonical로 연결한 뒤 나머지를 `duplicate`로 보존한다. 같은 `sourcePitchId`가 경기 안에서 반복되면
경고와 모든 원천 위치를 표시하지만 그 ID만으로 행을 합치거나 적재를 차단하지 않는다.

타석 결과의 `실책으로 출루`는 일반 땅볼 출루와 구분한다. 구체적인 원천 결과가 없거나
`field_out`·`fielder_choice`로만 제공된 경우에는 실책 출루 문구를 우선하며, 희생타·낫아웃 같은
복합 결과의 우선순위는 유지한다. 정규화 규칙 수정으로 기존 봉인 기록을 자동 변경하지 않는다.

endpoint 원문은 canonical JSON을 gzip으로 압축해 `.data/source`에 불변 저장하고 manifest에 endpoint,
응답 hash와 수집 시각을 남긴다. 최초 정리 원장과 당시 finding은 `.data/original`에 한 번만 저장한다.
현재 권위는 `.data/current/<gameId>.json` 하나가 `.data/active`의 versioned artifact를 가리킨다.
재수집으로 대체된 원장과 원천 실패는 `.data/superseded`에 generation/content-hash snapshot으로
보존하고, finding이 없으면 빈 envelope sidecar를 만들지 않는다. 자세한 내용은
[수집과 staging 운영](docs/collection-and-staging.md)을 참고한다.

대시보드와 수집·보정·DB 목록은 시작 시 검증한 current 표시 요약을 메모리에서 재사용한다.
조회마다 전체 경기 파일을 다시 읽지 않고, 저장·보정·적재로 바뀐 경기만 갱신한다. 실제 원장 읽기와
저장·적재 검증은 파일을 기준으로 수행하며 서버 시작 전 전체 무결성 검증도 유지한다.

## 경기 보정

`/correct`는 현재 staging·quarantine 원장과 명시적으로 선택한 superseded snapshot을 연다. 기본
화면은 검토가 필요한 경기만 표시한다.
이벤트 목록은 JSON 원장과 1:1이며 숨겨진 movement 하위 행이나 자동 생성 이벤트가 없다.

- 한 행 또는 최대 100개의 서로 다른 행을 한 번에 추가하고, 수정·삭제·위/아래 이동·위치 지정 이동
- 이닝·타석 단위 접기/펼치기와 finding 대상 행 자동 펼치기
- 기록정정 검토함에서 이동한 경우 KBO 공지 내용과 선수별 전후 공식 기록 표시
- 기록정정 초안을 열 때 현재 DB revision으로 경기·타석을 다시 확인하고, 기존 작업본이 있으면
  수동 수정·구속·구종·revision base를 유지한 채 이어서 열기
- 정정 내용이 저장된 작업본을 검증해 목록·상세에 `DB 적재 대기` 표시와 해당 경기 적재 링크 제공
- `unresolved`를 원문과 원천 위치를 유지한 typed 행으로 교체
- roster와 공식 기록 수정
- 공식 기록 불일치의 팀·선수 식별과 타자·투수별 공식값/compiler 계산값 비교
- 타자·투수·주자·교체 선수의 경기 roster 검색
- Naver 원문 또는 사용자가 확정한 중계 문구 저장
- 선택한 투구 상세의 tracking 원천 위치·PTS 순번·metric·resolution 확인과 실제 예외의 연결·제외
- 원장 편집으로 삭제된 PA 시작을 가리키는 tracking 문맥의 명시적 일괄 재계산
- immutable source의 선택 행 주변 relay JSON과 같은 block 관련 PTS 원문 확인
- 명령 단위 undo/redo와 `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`

여러 행 추가는 드로어의 순서형 목록에서 각각 구조화해 작성한다. 제출 시 기존 batch 한 건으로
원자적으로 적용되며, 전부 성공하거나 전부 실패하고 한 번의 undo로 함께 되돌린다.

끝내기 플레이의 주자 이동을 보정하면 종료 뒤 원문의 잔루 표시는 베이스 비교에서 제외한다.
compiler가 최종 끝내기임을 확인한 경우에만 적용하며, 점수·아웃·공식 기록과 실제 이동 검증은 유지한다.

타석 결과 편집기는 결과와 타자·투수·타점·직접 기록 아웃·타자 생존 예외·타구 유형·번트 여부만
다룬다. 주자 이동은 별도 `runner_advance` 행으로 편집하고, 타석 플레이에 속하면 해당
`plateResultEventId`를 참조한다. 각 명령 뒤 서버는 작업 사본 전체를 다시 compile하고 finding을
교체한다. 차단 상태도 명시적으로 quarantine에는 저장할 수 있지만 staging 승격과 DB 적재는
불가능하다. 자세한 내용은 [보정 운영](docs/correction.md)을 참고한다.

동일한 투구 연결을 유지한 채 원장 편집으로 compiler PA 시작만 바뀌면, 편집 전 compiler 문맥과
일치하던 tracking 후보와 그 중복 후보는 새 PA를 따라간다. 이미 삭제된 PA ID를 가진 과거 작업본은
`삭제된 PA 문맥 재계산`으로 복구하며, 존재하는 다른 PA와의 실제 불일치는 계속 차단한다.

## 데이터베이스 적재

`/database`에서 검증된 경기를 한 건씩 또는 시즌·검색 조건 전체로 선택해 등록한다. 서버가 문서 hash와
revision base까지 확정한 선택은 필터·페이지를 바꿔도 유지된다. 개별 선택과 제외를 지원하며 선택 뒤
수정된 문서는 건너뛴다. 신규 경기는 revision 1, reopen·재수집한 교정본은 current+1이 된다.
일괄 적재는 최대 2개씩 처리하며, 각 경기는 독립 transaction과
독립 job이어서 한 경기의 실패가 다른 경기를 중단하지 않는다. 각 적재 transaction은 다음 경계를
한 번에 수행한다.

화면 헤더는 DB 상태·적재 대기·저장 경기 수만 압축해 표시한다. `적재 대기`, `저장된 경기`,
`작업 기록`은 왼쪽 고정 높이 가상 목록에서 전환하고, 행에는 경기 식별과 상태만 둔다. 단건 적재,
current 교정 초안, Naver 재수집, revision 선택과 오류 확인은 오른쪽 상세에서 수행하며 선택한 저장
경기의 revision 이력만 한 번 조회한다.

경기와 작업 기록은 서버에서 50건씩 조회한다(최대 200건). 필터에서 제외된 경기 상세는 닫힌다.
일괄 작업은 완료·실패·건너뜀/중단·진행·대기 수와 현재 경기를 표시하며 대기 경기만 취소할 수 있다.
`.data/imports`에 확정 선택, 작업 의도, 경기별 결과와 요청 키를 보존한다. 재시작 후 미완료 작업은
DB manifest와 대조하며 자동 재실행하지 않는다. DB 저장 뒤 파일 정리 실패는 저장 성공과 후속 정리
필요를 구분한다. 보정 저장 완료 영역에서 저장한 문서 hash로 단건 적재하거나 다음 검토 경기를 연다.

1. 원장 strict decode와 전체 compile
2. Naver source identity와 경기 당시 팀·선수 이름 snapshot upsert
3. 원장 fact, 원자적 play, 최종 movement, play 전후 상태, PA lifecycle·bridge, 기록 projection
4. DB 재조회·V2 원장 hydration·recompile과 document/projection hash 검증
5. 새 revision seal과 current pointer 원자 전환

차단 finding이나 무결성 불일치가 있으면 전체 rollback한다. DB는 정리된 원장 행도 provenance로
보존하지만 공개 재생·분석은 typed fact를 직접 사용한다. 적재가 성공하면 같은 hash의 staging
작업본만 제거하고 immutable original/source 증거는 보존한다. 자세한 내용은
[PostgreSQL persistence 운영](docs/postgresql-persistence.md)을 참고한다.

DB V3는 경기와 독립된 `catalog` 팀·선수 entity를 두고 sealed fact는 변하지 않는 Naver source
identity를 참조한다. 이후 KBO 공식 ID에 연결해도 과거 projection hash는 바뀌지 않는다. tracking
측정치는 `tracking_observations`에 한 번만 저장하고 pitch에는 link만 둔다.

구속·구종은 Naver 투구 행의 `speed`·`stuff`에서 수집해 원장, pitch fact와 재생까지 전달한다.
tracking이나 원천 pitch ID가 없어도 저장하며, `직구` 등 제공 명칭을 그대로 유지한다.
DB migration `0004_pitch_metadata`부터 analytics/projection 계약은 `4/4`다. V3 봉인 기록은 기존
컬럼·hash로 읽으며 과거 revision을 다시 쓰지 않는다. 기존 기록의 일회 보완은
[구속·구종 보완 운영](docs/pitch-metadata-enrichment.md)을 따른다.
현재 migration head는 `0010_player_height_lookup`다. `crossPlateY`는 플레이트의 종방향 위치이며
공의 높이가 아니다. Zone/Chase 분석은 재생과 같은 궤적으로 그 위치의 높이를 계산하고, 필요한
궤적값이 없으면 `NULL`로 남긴다. 봉인된 원천값과 projection hash는 유지한다.
`0006`은 예외 처리에 subtransaction이 필요한 이 함수를 `PARALLEL UNSAFE`로 지정해 대규모 집계의
병렬 실행 충돌을 방지한다. 좌표 공식과 analytics/projection 계약은 그대로다.
DB에서 다시 읽은 projection 행은 descriptor가 소유한 column 순서와 runtime decoder로 shape,
nullability, enum, safe integer, row count, game/revision 문맥과 key uniqueness를 확인한 뒤에만 hydration과
replay에 사용한다.

분석은 `game_id`가 아니라 `analytics.current_pitches`, `current_plate_appearances`,
`current_plays`, `current_runner_movements`, `current_player_game_*`,
`current_player_season_*`의 grain을 기준으로 한다. PostgreSQL은
`127.0.0.1:${KBO_DB_PORT:-5433}`에만 공개되며 `.env`의 별도 analyst 계정은 `analytics` 조회만
가능하고 기본 transaction이 read-only다. 예제는 [database/examples](database/examples)를 참고한다.

## KBO 선수 등록·이동 동기화

V3 DB 적재 뒤 2024 Register 일별 snapshot과 Trade 월별 이동 내역을 수집한다.

```powershell
pnpm registry:sync -- --season 2024
pnpm registry:sync -- --season 2024 --from 2024-03-23 --to 2024-10-01 --dry-run
pnpm registry:sync -- --season 2024 --resume <run-id>
```

기본 범위는 DB의 해당 시즌 sealed 경기 최소·최대 날짜다. 원문은
`.data/registry/source`에 gzip/hash manifest로 저장한다. 1군 등록과 구단 소속 stint는 분리되며,
일별 페이지 공백을 넘어 등록 stint를 추론하지 않는다. 개명·등번호 변경은 event만 남기고 소속
stint를 바꾸지 않는다. 모호한 동명이인은 병합하지 않고 resolution issue로 남긴다. 공개 Registry
API나 화면은 이 버전에 포함하지 않는다.

## KBO 기록정정 검토

`/record-corrections`는 KBO 기록정정현황을 수집해 기본 `미처리` 큐에 적용 가능·후보 확인·경기 연결
필요만 표시하고, 이미 반영·지원 범위 외·해결·무시는 `완료·제외` 큐로 분리한다. 경기 연결은 날짜와
원정·홈 팀으로 판단하며 구장명 표기 차이나 미제공으로 제외하지 않는다. 더블헤더는 공지의 경기
번호로 구분하며 확정할 수 없으면 후보 확인으로 남긴다. 미연결 공지도 해당 경기 적재 후 다시 평가한다. 목록 API는
날짜·대진·전후 기록·상태만 반환하며 공지 원문, 통계 변경과 후보는 항목을 선택할 때만 단건
조회한다. 처리 성공 뒤에는 다음 미처리 항목과 남은 건수를 표시한다. 서버는 마지막 성공으로부터
24시간 뒤 다시
확인하고, 기한을 넘긴 채 재시작하면 한 번 즉시 실행한다. 실패 후 재시도 간격은 6시간이다.
화면의 `지금 동기화`로 보유한 sealed 경기 시즌을 수동 확인할 수도 있다.

원문 landing HTML, control 응답과 모든 pagination JSON은
`.data/record-corrections/source/<season>/<run-id>/`에 gzip과 SHA-256 metadata로 저장한다. 중단된
run은 같은 request key의 검증된 artifact부터 이어가며, 필수 페이지를 모두 취득·파싱한 경우에만
season revision을 seal한다. 2024 정규시즌 공식 표는 12개 열과 10개 공지를 기준 fixture로
비식별화해 회귀 테스트한다.

검토함에서 확정 후보를 선택하거나 무시 사유를 남긴 이력은 append-only다. `보정 작업 열기`는
current sealed revision을 기존 correction draft로 열 뿐 DB fact를 바꾸지 않는다. 제안 패널의
`제안 적용`도 플레이와 지원되는 공식 타자·투수 기록을 correction session의 원자적 batch로만
적용한다. 타자·투수·야수의 지원 여부는 통계명뿐 아니라 기록 범위를 함께 판정한다. 예를 들어
투수의 `희비`는 피희생플라이 원문 증거로 보존하되 타자 희생플라이 기록으로 적용하지 않는다.
적용 가능한 플레이나 통계가 전혀 없는 공지는 `지원 범위 외`로 분류해 알림과 수동 검토 건수에서
제외한다. 전체 compile, proposal hash와 session/base/source hash 검사를 통과해야 하며, 이후
`현재 원장 저장`과 Database import는 기존 버튼으로 별도 확인한다. 야수 실책과 지원하지 않는
통계는 원문 증거로 보이지만 원장 기록에는 쓰지 않는다.

대주자·대타의 타순은 해당 타석 전 교체 이력까지 확인하며, 여러 투수가 등장하는 공지는 각 선수의
공식 기록에 따로 연결한다. 생략된 선택 계수에 KBO 정정 후 값이 필요한 경우 제안에 선수·항목과
`미제공 → 값`, `KBO 공지로 보완 예정`을 표시한다. 기존 `제안 적용`·저장·DB 적재로 반영하며,
이미 명시된 값이 공지 전후와 모두 다르면 덮어쓰지 않고 검토 대상으로 남긴다.

## 경기 재생

`/replay`는 current 또는 선택한 과거 sealed revision의 원자적 play frame을 재생한다. 타석 결과와 연결 주자 행은 같은
frame에 원장 순서로 표시되고 상태는 play 전후 한 번만 바뀐다. 투구, 독립 주자 이동, 교체와
반이닝 경계는 독립 play가 되며 공지·판독은 상태를 바꾸지 않는 재생 항목 또는 play 주석이 된다.

브라우저는 시즌과 월을 고른 뒤 경기 수가 표시된 달력 날짜로 seal된 DB 경기를 좁히거나, 경기 ID를
직접 검색해 카드 목록에서 고른다. frame page를 모두 받은 뒤 재생 위치와 속도를 로컬에서 관리한다.
DB catalog는 경기 날짜·팀·current revision·전체 revision 수를 한 번에 제공한다. 기록정정·
Database·재생의 긴 목록은 viewport와 overscan 구간만 렌더링하고, 수집은 서버 페이지네이션을 사용한다.
Database의 전체 revision hash
이력은 사용자가 해당 경기를 선택할 때만 조회한다. 운영 콘솔의 검색·범위·선택은 URL 검색
파라미터에 저장되어 새로고침과 뒤로/앞으로 탐색에서 복원된다.
경기 변경 패널은 현재 재생 위에 열리므로 새 경기를 불러오기 전까지 기존 화면을 유지한다.
점수·BSO·주자·현재 타자와 투수, PA, typed 주자 이동·수비진, tracking metric과 유효한 좌표가 있는
스트라이크 존을 확인할 수 있다. 자세한 내용은
[경기 재생 운영](docs/replay.md)을 참고한다.

## 백업과 복원

backup은 API writer를 멈춘 같은 시점의 파일 workspace와 PostgreSQL custom dump를 `.backups`에
저장한다. manifest의 app/migration은 compose 파일의 기대값이 아니라 실행 중인 API와 DB에서 읽어
기록한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
```

복원은 현재 workspace와 DB를 교체하므로 확인 switch가 필요하다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore.ps1 `
  -BackupDirectory .backups\kbo-workbench-YYYYMMDDTHHMMSSfffZ `
  -ConfirmDataReplacement
```

## 개발 품질 명령

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm performance
pnpm schema:game:check
pnpm build
docker compose config
docker compose build
```

DB V3 fresh bootstrap과 V2 current-only 전환 절차는
[PostgreSQL persistence 운영](docs/postgresql-persistence.md)에 있다. V2 volume은 삭제하지 않고 별도
V3 volume과 함께 보존한다.

## 문서

- [분석 기능 전체 설계와 기능별 구현 계획](docs/analysis/README.md)
- [구현 명세](kbo_workbench_web_implementation_spec.md)
- [Game Core 규칙](docs/game-core-rules.md)
- [수집과 staging 운영](docs/collection-and-staging.md)
- [보정 운영](docs/correction.md)
- [PostgreSQL persistence 운영](docs/postgresql-persistence.md)
- [경기 재생 운영](docs/replay.md)
- [백업과 복원 운영](docs/backup-and-restore.md)
- [Windows Docker Desktop 설치](docs/windows-installation.md)
- [테스트와 성능 기준](docs/testing-and-performance.md)
- [ADR 0001](docs/adr/0001-local-web-modular-monolith.md)
