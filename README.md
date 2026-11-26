# KBO Workbench

Naver KBO 문자중계를 수집하고 사람이 보정한 뒤, 검증된 경기 기록을 PostgreSQL에 저장해
분석·재생하는 개인용 로컬 웹 워크벤치다. 원본 응답은 증거로 보존하고, 경기 상태와 통계는
단일 결정론적 컴파일러가 계산한다.

**처음 사용한다면:** [빠른 시작](#빠른-시작) → [사용 흐름](#사용-흐름) → [분석과 재생](#분석과-재생)

**개발·운영 문서:** [배포](docs/deployment.md) · [개발과 검증](#개발과-검증) · [전체 문서](#문서-안내)

## 빠른 시작

Git과 Docker Desktop이 필요하다. Docker Desktop은 **Linux container 모드**로 실행한다.
일반 사용에는 호스트의 Node.js·Python 설치가 필요하지 않다.

### 1. 로컬 설정 준비

저장소 루트의 PowerShell에서 실행한다. 기존 `.env`가 있으면 유지한다.

```powershell
if (-not (Test-Path -LiteralPath .env)) {
  Copy-Item -LiteralPath .env.example -Destination .env
}
```

생성한 `.env`에서 다음 값을 설정한다. 암호는 예시값을 바꾸고, DB 계정과 분석 계정에 서로 다른
암호를 사용한다.

| 설정                                                | 용도·기본값                                     |
| --------------------------------------------------- | ----------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | 로컬 DB 계정·암호·데이터베이스                  |
| `KBO_ANALYST_USER`, `KBO_ANALYST_PASSWORD`          | `analytics` 전용 읽기 계정                      |
| `KBO_DATA_DIR`                                      | 파일 워크스페이스 경로, 기본 `./.data`          |
| `KBO_WEB_PORT`                                      | 웹 포트, 기본 `8080`                            |
| `KBO_DB_PORT`                                       | 외부 분석 도구의 로컬 DB 접속 포트, 기본 `5433` |

### 2. 빌드하고 시작

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

`migrate`가 `Exited (0)`, `db`·`api`·`web`이 `healthy`이면
[http://127.0.0.1:8080](http://127.0.0.1:8080)을 연다. 포트를 바꿨다면 해당 포트로 접속한다.
**설정 및 진단**(`/settings`)에서 API·DB·워크스페이스 상태를 확인할 수 있다.
시작 시 현재 작업본의 무결성을 검사한다. 임시 파일은 전용 `.temporary` 폴더에서 회수하며,
업데이트 후 첫 실행에만 기존 위치의 임시 파일을 정리한다.

GNU Make가 있으면 설정 준비에 `make init`, 빌드·migration·준비 상태 확인에 `make deploy`를
사용할 수 있다. 자세한 환경 준비는 [Windows 설치](docs/windows-installation.md),
운영 명령은 [Makefile 배포](docs/deployment.md)를 참고한다.

## 사용 흐름

상단에서 **데이터 관리**와 **분석** 영역을 전환한다. 처음에는 아래 순서로 경기를 준비한다.

| 단계       | 화면                | 할 일                                                           |
| ---------- | ------------------- | --------------------------------------------------------------- |
| 1. 수집    | `/collect`          | 기간·시즌을 정해 **경기 확인** 후 수집 대상을 선택한다.         |
| 2. 보정    | `/correct`          | 검토가 필요한 경기의 원문·차단 사유를 확인하고 원장을 수정한다. |
| 3. DB 적재 | `/database`         | **적재 가능** 경기를 선택해 검증된 기록을 저장한다.             |
| 4. 분석    | `/analysis/players` | 시즌과 투수·타자를 선택해 선수별 기록을 살펴본다.               |
| 5. 재생    | `/replay`           | 저장된 경기와 revision을 선택하거나 분석의 근거 장면을 연다.    |

수집 화면의 **경기 확인**은 일정만 조회한다. 실제 중계 수집은 대상을 확정해 별도로 실행한다.
일정 조회는 실제 달력 날짜로 이루어진 기간을 받는다.
일정·경기 원문 조회는 Docker 이미지에 포함된 WebKit의 headless 모드를 사용한다.
수집 결과를 DB에 자동 적재하지 않는다. 탐색·표시 필터와 실제 실행 대상은 구분되어 있다.
수집·적재 이력은 재시작 후에도 보존하고 중단된 작업은 자동 재실행하지 않는다.
완료 경기의 일반 땅볼 출루는 연결이 확인된 이닝별 기록 약호를 함께 사용해 실책 출루를 구분한다.

### 수집 결과와 보정

| 표시      | 저장 상태        | 다음 작업                                                      |
| --------- | ---------------- | -------------------------------------------------------------- |
| 적재 가능 | `ready`          | 차단 사유가 없는 원장. DB에 적재할 수 있다.                    |
| 검토 필요 | `quarantine`     | 원문과 검증 결과를 대조해 보정한다.                            |
| 원천 실패 | `source_failure` | 필수 응답·전송 실패로 원장을 만들지 못했다. 수집을 재시도한다. |

보정 목록은 원장의 이벤트 하나당 한 행이다. 행 추가·수정·삭제·이동, 선수·공식 기록 수정,
중계 문구·비교용 관측값 교정과 tracking 연결을 구조화된 입력으로 처리한다.
모든 명령 뒤 서버가 경기 전체를 다시 검증하며 명령 단위 undo/redo를 지원한다.
차단 사유가 남은 작업본은 **검토 필요**로 저장할 수 있지만 DB 적재는 할 수 없다.

수집 HTTP는 응답 해석이 끝난 뒤에도 취소·시간 제한을 확인하며, 실패한 응답 본문은
종료·재시도 전에 해제한다. 취소 뒤 늦게 도착한 응답을 수집 성공으로 처리하지 않는다.

**KBO 기록정정 검토**(`/record-corrections`)에서는 공식 공지와 경기·타석 후보를 확인하고
화면에서 본 평가의 보정 작업을 연다. 후보가 바뀌면 최신 결과를 다시 확인한다. 제안 적용은 작업 사본만 변경하므로 **현재 원장 저장 → DB 적재**를 마쳐야
분석·재생에 반영된다. 적용 중 공지가 재평가되면 현재 제안을 다시 확인한다. 평가 중 최초 적재나
새 revision으로 경기 후보가 바뀌면 이전 평가 결과는 저장을 거부한다. 적재 후에는 영향받은
대진의 공지를 다시 확인해 변경된 후보를 반영하고 유효한 승인과 수동 선택을 보존한다. 이미
저장된 DB 기록은 새 revision을 추가해 교정한다.

공식 기록정정의 재평가는 경기 봉인과 함께 기록되며 서버 재시작 후에도 이어진다.
저장한 작업 사본을 적재할 때 현재 공지, 같은 경기의 공지 충돌과 작업 사본의 승인 근거를 다시 확인한다.
커밋 응답이 유실되면 봉인 트랜잭션에 기록한 적재 작업 식별자로 결과를 복구한다.
봉인 결과 확인이 지연되면 자동으로 다시 조회하며 적재 상세 화면에서도 확인할 수 있다.

세부 절차는 [수집](docs/collection-and-staging.md), [보정·기록정정](docs/correction.md),
[DB 적재](docs/postgresql-persistence.md)에 정리되어 있다.

## 분석과 재생

**선수 분석**에서 모든 적재 시즌의 선수를 이름 또는 ID로 검색한다. 검색 결과에서 이름, 공식
출생연도, 주 포지션을 함께 보여주고 아래에 거쳐 온 구단을 순서대로 표시한다.
선택하면 기본 기록에서 수집된 연도별 타격·투구 성적을 최신순으로 본다. 시즌 중 이적한 경우
거친 팀의 기록을 합산해 해당 연도에 한 줄로 표시한다. 선수 머리글에는 프로 경력 기간이나 수집
기록 기간을 표시한다.
선수 머리글에서 다른 선수를 검색하거나 분석 시즌을 바꿀 수 있다. 시즌 옆의 `경기 종류·기간`을
펼쳐 다섯 분석 탭의 공통 조회 조건을 바꾼다. 기본 기록은 날짜를 지정하면 해당 시즌의 선택
기간을 표시한다.
선수 리포트에는 **기본 기록 · 경기별 · 상황별 · 구종·코스 · 맞대결** 탭이 있다. 선택 시즌에
타격과 투구 기록이 함께 있으면 역할을 고를 수 있다. 선수나 시즌을 바꿔도 이전 탭을 계속 볼
수 있으면 유지한다. 탭을 이동할 때 선수·시즌·경기 종류·기간을 유지한다.
시즌 상태 확인으로 자료 변경을 감지하면 열린 화면의 선수 목록을 갱신한다.
분석은 정규시즌이 기본이며 포스트시즌과 올스타전을 각각 선택할 수 있다. 공식 경기 ID를 확인한
순위 결정전은 포스트시즌 분석에 포함한다. 시범경기와 미분류 경기도 각각 조회할 수 있다.
모델 학습에는 확인된 정규시즌 경기를 사용한다.

| 영역      | 주요 기능                                               |
| --------- | ------------------------------------------------------- |
| 기본 기록 | 연도별 통합 성적, 같은 범위 리그 평균, 두 기간 비교     |
| 경기별    | 경기별 타격·등판 성적, 해당 기록의 재생, 등판 부담·변화 |
| 상황별    | 상대 손, 홈·원정, 타석 결과 직전 득점권, 카운트별 성적  |
| 구종·코스 | 구종 비중, 코스 지도, 배합·궤적, 구질, 선구안           |
| 맞대결    | 직접 타격 성적과 타석 재생, 유사 조건의 투구 반응 비교  |
| 리그·경기 | 선수·팀 성적, 주루·추가 진루, 구장 득점 환경, 경기 재생 |
| 분석 관리 | 자료 품질, 분석 모델 상태·학습·갱신                     |

맞대결과 주루의 선수 선택은 이름·팀·ID로 검색한다. 맞대결은 선택한 범위에서 직접 상대 기록이
있는 선수를 먼저 보여 준다.

핵심 기록과 비교를 먼저 보고 상세 표·계산 정의·분모·근거 기록을 펼쳐 확인한다.
리그 순위 표의 팀 열은 경기 당시 소속을 표시한다. 미제공 값과 계산 불가 값은 —로 표시한다.
구질의 평균 포심 비교와 타자 선구안의 가정은 실제 코스·관측 통계와 구분해 해석한다.

구종 배합은 각 카운트의 구종 비중을 원으로, 한 공 뒤 관측된 전이율을 화살표로 표시한다.
카운트 원은 12시부터 비중이 큰 구종 순서로 배치한다. 작은 조각에는 최소 10°를 배정하고,
확대 목록에는 실제 비중을 표시한다. 타자의 카운트별 대응도 같은 표시 규칙을 사용한다.
전체 타자 한 장이나 좌·우타자 두 장을 선택하고, 원을 확대해 구종을 고르면 모든 화살표에 그 구종을
적용한다. 마우스가 원을 벗어나면 확대와 구종 목록이 닫힌다. 트래킹에 타석 방향이 없으면
같은 경기 원문의 선수 프로필로 보완하며, 미확인·충돌·양타석은
전체에 포함한다. 구종 배합 탭을 열 때 전이율을 별도 조회하며, 과거 원장의 `ball`도
명시적 사구 결과에 직접 연결되면 사구로 집계한다.
상세 표는 선택한 카운트·구종의 투구 수와 결과별 비율을 표시한다. 삼진을 펼치면 루킹·헛스윙·기타,
인플레이를 펼치면 안타 종류·타구 아웃·희생타·출루 결과를 볼 수 있다.

기본 기록·구질·타자 특성·선구안·코스는 공통 A/B 시즌·날짜 선택으로 비교한다. 비율 차이는
%p이며 분자·분모와 원천을 함께 확인한다. 시즌별 기준이 다른 구질 좌표의 차이는 제공하지 않는다.
선택·계산·표본 정책은 [기간 비교](docs/analysis/period-comparison.md)를 따른다.
스트라이크존은 경기 시즌에 적용할 수 있는 가장 최근의 기준과 타자 신장으로 계산한다.

투수 **코스·결정구**는 **코스·반응 / 구종 배합 / 기간 비교 / 표본 기준** 탭을 제공한다.
**구종 배합**에서 카운트 이동과 삼진·볼넷·2스트라이크 일반 파울 확률을 보고,
원 가운데를 눌러 해당 카운트의 전체 구종 결과를 아래 상세 표에서 확인한다. 구종을 고르면 상세에서
해당 코스로 이동할 수 있다.
**기간 비교**에서 시즌·기간 A/B를
적용하면 사용 비중·헛스윙률·CSW·종결 인플레이 안타 비율의 지도를 같은 눈금으로 비교한다.
구역을 선택하면 두 기간의 분자·분모와 차이(%p), 투구 근거를 확인할 수 있다.
타자 **반응·성적**의 **카운트별 대응** 탭은 받은 구종과 전이율을 전체 또는 좌완·우완 비교로
표시한다. 선택한 카운트·구종의 스윙률을 확인하고 해당 상대 조건으로 코스 지도를 열 수 있다.
Naver 프로필의 투구 손 표기가 빠진 경기는 [검토한 KBO 공식 자료](docs/analysis/features/08-batter-profile.md#카운트별-대응)로 보완할 수 있다.
**타석 결과** 탭은 공통 조회 범위와 종결 투수 손을 적용해 마지막 공의 구종별 타격 성적을 표시한다.
두 화면의 **기간 비교** 탭은 조건을 적용하거나 적용한 주소로 들어갈 때 비교 결과를 불러온다.

분석의 근거 링크는 해당 경기·revision의 정확한 투구·타석·플레이로 연결한다.
같은 탭에서 열었다면 **분석으로 돌아가기**로 선수와 조회 조건을 복원한다. 코스 화면에서는
마지막으로 선택한 구역 또는 **모든 코스**도 복원한다.
재생은 현재 또는 과거의 봉인된 DB 기록을 사용하고, 모든 frame의 순서·개수·hash를 검증한 뒤
브라우저에서 재생 위치와 속도를 조절한다.

기대득점·승리확률·구종 기대 효과 등은 검증된 모델이 준비된 경우에 제공한다.
조회 중 전체 학습을 시작하지 않으며, 학습·선택적 자동 갱신은 **분석 모델 관리**에서 수행한다.
지원 시즌·선행 분류·모델별 한계와 CLI는 [모델 운영](docs/analysis/model-management.md)을 따른다.

계산 정의와 범위는 [분석 문서](docs/analysis/README.md), [투구 움직임](docs/pitch-shape-analysis.md),
[타자 선구안](docs/batter-discipline-analysis.md), [스트라이크존](docs/strike-zone.md),
[경기 재생](docs/replay.md)을 참고한다.

## 데이터 구조와 원칙

```text
Naver 원본 응답 → 불변 source bundle → 보정 가능한 V2 원장
  → game-core 전체 컴파일·검증 → current manifest와 active artifact
  → 검증된 ready 원장의 PostgreSQL 적재·revision 봉인 → typed fact 기반 분석·재생
```

- 원본과 최초 원장은 증거로 보존한다. 해석하지 못한 중계도 원문·위치와 함께 남기며 누락된
  투구·결과·주자 이동을 지어내지 않는다. `source_failure`는 원장을 만들지 못한 별도 상태다.
- V2 원장은 교정할 소스다. 아웃·주자·점수·타석·통계의 계산 권위는 `game-core`에 있다.
  보정 타임라인은 Ctrl/Shift 다중 선택과 선택 행의 원자적 삭제·이동, 한 번의 undo/redo를 지원한다.
  타석 결과와 기존 주자의 이동은 별도 이벤트로 기록하고 하나의 플레이로 원자 검증한다.
  교체 뒤 같은 타자 표시는 진행 중 타석을 유지하며, 야수선택 책임 승계와 추가 진루 중
  태그아웃의 책임 소멸을 구분한다. 중복 종료 선언도 원문을 가진 안내 행으로 보존한다.
- DB 적재는 전체 검증·hash 대조·재조회·재컴파일·봉인을 한 transaction에서 수행한다.
  타석 방향이 트래킹에 없으면 같은 경기 원문의 선수 프로필을 분석에 사용한다.
  [프로필 보완 절차](docs/analysis/features/04-pitch-location.md#타석-방향-보완과-구종-배합-응답)를 참고한다.
  차단 사유나 무결성 오류가 있으면 전부 rollback한다.
- 신규 경기는 revision 1, 이후 교정은 새 revision을 추가한다. 봉인된 기록은 불변이며
  분석·재생은 작업 JSON을 다시 계산하지 않고 DB의 typed fact를 사용한다.

| 위치                                 | 역할                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| `.data/source`, `.data/original`     | 불변 원문 bundle과 최초 원장·검증 결과                         |
| `.data/current`, `.data/active`      | 현재 상태 manifest와 그 manifest가 가리키는 versioned artifact |
| `.data/superseded`, `.data/journals` | 교체된 artifact 보존과 중단 복구                               |
| `.data/collection`, `.data/imports`  | 수집·적재의 확정 선택과 작업 이력                              |
| PostgreSQL volume                    | 봉인된 revision과 분석·재생 fact                               |
| `.backups`                           | 같은 시점의 DB·파일 워크스페이스 쌍 백업                       |

KBO 선수 등록·이동 자료는 별도 provenance와 시즌 revision으로 관리한다.
동기화 CLI와 등록·소속 구분은 [Registry 운영](docs/postgresql-persistence.md#registry-provenance)에 있다.
선수 검색의 공식 경력 수집은 [선수 경력 원문과 확인 기준](docs/postgresql-persistence.md#선수-경력-원문과-확인-기준)을 따른다.

## 운영과 백업

모든 명령은 저장소 루트에서 실행한다.

| 작업      | Docker Compose               | GNU Make      |
| --------- | ---------------------------- | ------------- |
| 상태 확인 | `docker compose ps --all`    | `make status` |
| API 로그  | `docker compose logs -f api` | `make logs`   |
| 일반 종료 | `docker compose down`        | `make down`   |

업데이트 전에는 수집·적재를 끝내고 보정 작업을 저장한다. GNU Make를 사용하면 같은 app version의
업데이트는 `make update`로 빌드·쌍 백업·배포를 실행한다. **app version이 바뀔 때는 checkout 변경 전에
`make backup`을 실행한 뒤**, 새 코드에서 `make deploy`를 실행한다.
Make가 없을 때의 백업 명령은 다음과 같다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
```

`.data`·`.backups`·PostgreSQL volume은 사용자 데이터다. 일반 종료 시 보존하며,
`docker compose down -v`는 DB volume을 삭제하므로 사용하지 않는다.
백업은 writer를 멈춘 같은 시점의 DB와 파일을 함께 저장한다. 복원은 두 데이터를 교체하므로
[백업·복원 절차](docs/backup-and-restore.md)의 대상·hash 확인을 따른다.
교체나 DB 복원에 실패하면 파일을 이전 위치로 되돌린 뒤 중지했던 서비스를 다시 시작한다.
DB가 실행 중이면 웹과 API를 중지한 상태에서도 복원할 수 있다.
컨테이너 재생성 뒤 이전 hostname의 잠금이 남으면 [중단된 writer 잠금 복구](docs/backup-and-restore.md#중단된-writer-잠금-복구)를 따른다.
업데이트와 실패 진단의 전체 순서는 [운영 배포](docs/deployment.md)에 있다.

외부 분석 도구는 기본 `127.0.0.1:5433`의 analyst 계정으로 접속한다.
해당 계정은 `analytics` 조회 전용이며 transaction도 기본 읽기 전용이다.
예제 쿼리는 [database/examples](database/examples)에 있다. API는 Docker 내부 network에 둔다.

## 개발과 검증

개발 환경은 **Node.js 24 · pnpm 10.15.1 · TypeScript strict · ESM**이다.
서버는 Fastify, 웹은 React·Vite, DB는 PostgreSQL 16을 사용한다.

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm schema:game:check
pnpm build
```

| 변경 범위                 | 추가 검증                                               |
| ------------------------- | ------------------------------------------------------- |
| 패키지 의존성·공개 export | `pnpm test:architecture`                                |
| PostgreSQL·재생           | `pnpm test:integration`                                 |
| 서버–웹 전체 흐름         | `pnpm test:e2e`                                         |
| 성능 경로                 | `pnpm performance`, 분석은 `pnpm performance:analytics` |

기본 `pnpm test`는 DSN이 없으면 PostgreSQL 통합 테스트를 건너뛴다.
통합·E2E는 고유한 임시 DB·워크스페이스를 사용하고 실제 Naver 호출 없이 fixture로 검증한다.
E2E에서 빌드하는 앱 이미지는 실행별 태그로 관리한다. Docker 자원과 임시 작업 폴더까지
정리하면 E2E가 통과한다.
PostgreSQL 통합 테스트의 DB 데이터는 1GiB tmpfs에 두어 디스크 동기화 지연을 피한다.
fsync·동기 커밋 설정은 유지하며 운영 volume을 사용하지 않는다.
기준과 세부 범위는 [테스트·성능](docs/testing-and-performance.md),
실자료의 격리 검증은 [분석 검증 절차](docs/analysis/real-data-validation.md)를 참고한다.

| 경로                                         | 책임                                                |
| -------------------------------------------- | --------------------------------------------------- |
| `apps/server`, `apps/web`                    | API 조립·작업 실행 / 웹 UI                          |
| `packages/contracts`, `packages/game-core`   | strict 런타임 계약 / 결정론적 컴파일러              |
| `packages/collection`, `packages/correction` | 원천 정규화 / 구조화된 교정 명령                    |
| `packages/persistence`, `packages/replay`    | 파일·DB 저장과 봉인 / typed fact 재생               |
| `database`, `schemas`, `tests`               | SQL migration·조회 예제 / 생성 스키마 / 회귀 테스트 |

변경 전 [에이전트 가이드](AGENTS.md)와 [구현 명세](kbo_workbench_web_implementation_spec.md)를 읽는다.
코드 탐색은 Graft를 사용하고 최초 색인·큰 변경 뒤에는 `pnpm graft:build`로 갱신한다.
UI 작업은 [설계 도구·작업 기준](docs/analysis/ui-design-workflow.md)과 [디자인 기준](DESIGN.md)을
따르며 실제 브라우저에서 확인한다.
품질 점검 프로필과 Codex 스킬은 [quality-sweep](docs/quality-sweep/kbo-workbench.md)을 참고한다.
미커밋 변경을 포함한 별도 소스 snapshot에서 검사하며 운영 데이터와 환경은 복사하지 않는다.

## 문서 안내

| 주제        | 문서                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 설치·운영   | [Windows 설치](docs/windows-installation.md) · [Makefile 배포](docs/deployment.md) · [백업·복원](docs/backup-and-restore.md)                                              |
| 구조·계약   | [구현 명세](kbo_workbench_web_implementation_spec.md) · [Game Core 규칙](docs/game-core-rules.md) · [구조 결정 ADR](docs/adr/0001-local-web-modular-monolith.md)          |
| 데이터 준비 | [수집](docs/collection-and-staging.md) · [보정·기록정정](docs/correction.md) · [PostgreSQL·Registry](docs/postgresql-persistence.md)                                      |
| 분석·재생   | [분석 전체 안내](docs/analysis/README.md) · [구현 상태](docs/analysis/implementation-status.md) · [모델 운영](docs/analysis/model-management.md) · [재생](docs/replay.md) |
| 유지보수    | [스트라이크존·신장](docs/strike-zone.md) · [구속·구종 보완](docs/pitch-metadata-enrichment.md) · [테스트·성능](docs/testing-and-performance.md)                           |

새 경기·시즌을 적재하면 공식 경기 분류와 필요한 분석 모델을 자동 갱신한다. 분류 정책이 바뀌면 첫 자동 점검에서 공식 일정을 다시 대조한다. 열린 분석 화면은 조회에 사용하는 시즌의 변경을 반영하고, 서버는 변경이 없을 때 시즌별 상태 요약을 재사용한다. 기존 수동 교정 원장과 sealed 기록은 보존한다. [자동 반영·복구·지원 범위](docs/analysis/automatic-preparation.md)를 따른다.
이미 분류된 경기가 빠진 새 일정은 채택을 거부하고 기존 일정을 유지한다.
