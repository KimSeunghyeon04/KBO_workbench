# KBO Workbench 품질 점검 프로필

이 프로필은 `quality-sweep`의 영역별 점검·재현·재점검 방식을 KBO Workbench에 적용한다.
규칙의 권위는 저장소 `AGENTS.md`, 구현 명세, 관련 문서·테스트에 있다. 공통 틀의 Claude 전용
명령·훅·사용량 예산·자동 커밋 지시는 가져오지 않는다. Codex 진입점은
`.agents/skills/kbo-quality-sweep/SKILL.md`다. 외부 `D:\Github\quality-sweep`는 선택적 참고 자료다.

## 실행 범위와 기준

| 항목      | 값                                                                               |
| --------- | -------------------------------------------------------------------------------- |
| 저장소    | `D:\Github\KBO_workbench` 또는 현재 clone의 Git root                             |
| 실행 환경 | Windows PowerShell, Node.js 24, pnpm 10.15.1, Python 3.11 이상                   |
| 점검 기준 | 현재 checkout의 staged·unstaged·untracked 소스와 Git HEAD를 함께 고정            |
| 코드 변경 | 요청된 범위의 결함 재현·수정. 점검만 요청하면 수정하지 않음                      |
| 브랜치    | 필요한 경우 `codex/quality-sweep-YYYYMMDD`; 기존 브랜치를 바꾸거나 커밋하지 않음 |
| 장부      | 실행별 임시 snapshot 폴더의 `quality-sweep-ledger.md`                            |
| 기본 한도 | 요청 범위 한 번 점검, 전체 재점검 최대 3회. 미완료·판단 필요를 구분해 보고       |

설치 요청은 점검 실행·자동 커밋·푸시·PR·배포·운영 데이터 변경의 허가가 아니다.
기존 장부가 있으면 확인된 기준 커밋과 비교해 바뀐 파일 및 호출부를 증분 점검한다.
과거 리뷰는 `docs/reviews/`에서 관련 항목만 읽고, 이미 수정됐다는 이유만으로 회귀를 제외하지 않는다.

## 시작과 기존 변경 보존

1. `AGENTS.md`, `README.md`, 구현 명세, 변경 영역의 문서·공개 `src/index.ts`·테스트를 읽는다.
   코드 경계는 Graft로 확인한다. 작업 전 `git status --short`, HEAD와 사용자 변경 경로를 기록한다.
2. 원래 checkout에서는 읽기만 하는 점검을 먼저 수행한다. 검사는 아래 도구가 만든 별도 snapshot에서
   실행한다. snapshot은 HEAD뿐 아니라 현재 소스 바이트를 복사하므로 미커밋·신규 파일도 포함한다.
3. 원래 checkout의 index·브랜치·파일을 자동으로 reset·restore·stash·clean·format하지 않는다.
   수정이 요청된 경우에만 가장 작은 patch를 적용하고 기존 변경과 분리해 설명한다. 사용자가
   계속 편집해 snapshot 검증이 실패하면 새 변경을 보존하고 새 snapshot을 만든다.

`verify`는 기록된 파일의 바이트뿐 아니라 현재 소스 파일 집합도 비교한다. snapshot 이후 새로
추가한 파일과 이전에 삭제했다가 복원한 파일도 변경으로 판단한다. 보호 경로는 이 비교에서도 제외한다.

저장소 루트 PowerShell에서 실행한다. `prepare`는 시스템 임시 폴더에 새 폴더를 만들며 기존 폴더를
덮어쓰거나 삭제하지 않는다. 출력된 절대 경로를 `$sweepSnapshot`으로 사용한다.

```powershell
$sweepTool = Join-Path (Get-Location) 'scripts/quality-sweep.py'
$sweepSnapshot = python -B -X utf8 $sweepTool prepare --source (Get-Location)
if ($LASTEXITCODE -ne 0) { throw 'snapshot 준비 실패' }
python -B -X utf8 $sweepTool verify --sandbox $sweepSnapshot
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm install --offline --frozen-lockfile
```

의존성은 snapshot에 따로 설치한다. 원래 `node_modules`를 링크·복사하거나 Linux에 mount하지 않는다.
snapshot 범위는 루트 파일과 `.agents`, `apps`, `packages`, `tests`, `scripts`, `database`, `schemas`,
`infra`, `docs`다. 대용량 연구 입력·로컬 산출물이 있는 `analysis`는 기본 복사 범위에서 제외하며, 그 안의
연구 코드를 점검하도록 요청받았다면 별도로 범위와 비식별 입력을 정한다.
Codex가 호출별 임시 폴더를 사용한다면 `prepare --parent`에 checkout 밖의 지속적인 writable root를
지정한다. 이후 호출에서도 같은 절대 경로를 사용하며, `.data`·`.backups` 안에는 snapshot을 만들지 않는다.
Corepack의 pnpm 10.15.1 캐시와 pnpm package store가 없으면 위 명령은 실패한다. 네트워크나 다른
버전으로 자동 우회하지 않고 환경 문제로 보고한다. Node가 24가 아니면 깨끗한 Node 24 컨테이너에
소스만 복사하고 새 의존성을 설치해 검증한다. 임시 폴더는 자동 삭제하지 않는다. 정리할 때는
manifest의 `sandbox`와 실제 절대 경로가 일치하는 해당 실행 폴더만 대상으로 한다.

## 사용자 데이터 보호

- `.env`와 중첩 `.env*`, `.data`, `.backups`, PostgreSQL volume은 읽기·복사·변이 대상에서 제외한다.
  공개 설정 예제인 루트 `.env.example`만 소스와 함께 복사할 수 있다.
- `prepare`는 Git 목록을 읽되 보호 경로는 파일 내용에 접근하기 전에 제외한다. symlink·junction은
  따라가지 않는다. Git에서 무시된 파일을 `scope_check.py`로 감지할 수 있다고 가정하지 않는다.
- `run`은 환경변수를 허용 목록으로 구성하여 DB DSN, `KBO_*`, `PG*`, `POSTGRES_*`, Compose 설정과
  `NODE_OPTIONS`를 전달하지 않는다. 운영용 환경 파일을 임시 환경으로 복사하지 않는다.
- 실행 명령은 아래 검사 명령과 명시적 Vitest 파일만 허용한다. `workspace:migrate`,
  `maintenance:*`, `registry:*`, 모델 학습, `db:*`, 직접 migration/import/restore 실행,
  `make deploy/update`, Docker·Compose·SQL 명령과 shell 표현식은 도구에서 거부한다.
- 이 도구는 실수 방지 장치이며 OS 보안 sandbox가 아니다. 허용된 검사도 저장소 코드를 실행한다.
  테스트가 외부 서비스·운영 경로를 사용하지 않는지 확인한다. 악성 코드나 임의 파일 쓰기를
  격리하지는 않는다. 필요하면 자격 증명·사용자 volume이 없는 별도 실행 환경을 사용한다.
- DB/replay를 고쳤다면 격리 integration을 생략하지 않는다. `test:integration`, `test:e2e`는 이
  일반 runner의 허용 목록에 없다. 해당 PowerShell 스크립트의 고유 자원 이름·임시 workspace·환경
  복원·정리 대상을 검토한 뒤 snapshot에서 별도로 실행한다. 운영 DB나 기본 Compose project에
  연결하지 않는다. 이 단계의 결과를 장부에 별도로 남긴다.

## 점검 영역

| ID  | 범위                                        | 우선 확인할 불변식                                                      |
| --- | ------------------------------------------- | ----------------------------------------------------------------------- |
| C   | `packages/contracts`, `schemas`             | strict decode, canonical NFC·숫자, 스키마·명시적 export 일치            |
| G   | `packages/game-core`                        | 단일 compiler, candidate commit, atomic play, 책임 주자·득점·partial PA |
| N   | `packages/collection`                       | 소스 행·근거 보존, 동강도 충돌, 안정 ID, tracking 연결, 취소·동시성     |
| E   | `packages/correction` 및 보정 API/UI        | structured command, version·hash CAS, undo/redo, 원문·tracking 보존     |
| P   | `packages/persistence`, `database`          | current journal·writer lock, transaction rollback, typed fact·seal·hash |
| R   | `packages/replay`, 재생 API/UI              | typed fact 권위, atomic frame, revision-bound cursor·전체 page 검증     |
| A   | 분석 contracts·game-core·persistence·server | 분모·null·단위·모델 근거, current-only 범위와 hash                      |
| S   | `apps/server`                               | composition root, bounded worker/job, 취소·SSE·복구, localhost 경계     |
| W   | `apps/web`                                  | 서버 상태 표현, canonical index·선수 범위·키보드, URL 상태·오류 복구    |
| O   | `scripts`, Compose·배포·백업                | 사용자 데이터 보존, 정확한 임시 자원 정리, DB/workspace 쌍 복구         |
| X   | 교차                                        | 계약→소비자, compiler→projection→replay, 변경된 규칙의 전체 호출부      |

위험 순서는 C→G→N→E→P→R→A→S→W→O이며 X는 각 변경과 마지막에 확인한다.
영역이 크면 파일 수가 아니라 책임·호출 경계로 나눈다. 순위 검색은 전수 검색이 아니므로 모든
호출부가 필요하면 Graft callers/grep을 사용한다. UI 변경은 관련 설계 스킬과 실제 브라우저로 검증한다.

## 라운드와 결함 판정

- 후보마다 파일·행, 어긴 규칙, 실제 입력→잘못된 결과, 심각도, 확신과 수정 소유 모듈을 기록한다.
  재현·근거가 없으면 기각 사유를 남긴다. 서브에이전트는 사용자나 적용 지침이 허용할 때만 사용한다.
- 높음: 소스 유실·상태/통계 오류·blocking 우회·원자성/불변성 훼손·사용자 데이터 손상.
  중간: 특정 경계에서 발생하는 오류·계약/호출부 불일치·핵심 규칙을 놓치는 회귀 테스트.
  낮음: 동작 영향 없는 이름·가독성. 미제공 값을 0으로 바꾸는 일은 표시 문제로 낮추지 않는다.
- 수정 요청이면 실패하는 회귀 테스트를 먼저 확보하고 같은 계층의 최소 수정으로 해결한다.
  Correction 오류는 선수·팀을 비식별 처리한 fixture로 고정한다. 기대값을 구현으로 계산하지 않는다.
- 핵심 규칙은 본문과 호출부 인자·분기에서 의미 있는 변이를 선택한다. 단순 문구·CSS 변경마다
  변이를 강제하지 않는다. 최종 diff와 소비자를 검토하고 관련 테스트 후 기본 품질 게이트를 수행한다.
- 계약·projection 버전 변경, migration, golden hash 갱신, 의존성 변경에 제품 결정이 필요하면
  선택지·권고를 기록한다. 테스트를 통과시키려고 strict 계약·검증을 약하게 만들지 않는다.

장부 최소 열은 `번호 / 영역 / file:line / 규칙 / 실패 시나리오 / 심각도 / 상태 / 원인 /
테스트·변이 근거 / 다음 조치`다. 상태는 후보·재현됨·수정됨·기각·판단 필요·환경 차단을 구분한다.
원인은 기존 결함·이번 수정이 만듦·덜 고침·테스트 공백을 구분한다. 원문·선수 개인정보·DSN을 넣지 않는다.
외부 `ledger.py`를 쓰려면 그 도구의 표 형식을 사용하되, 형식 검사 성공을 완료 검증으로 간주하지 않는다.

## 고치지 않는 경로

아래는 외부 `scope_check.py`와 함께 쓸 수 있는 보조 목록이다. Git에서 무시된 사용자 데이터의
보호 수단은 위의 격리 절차이며, 목록 위반을 발견해도 기존 파일을 자동으로 되돌리지 않는다.
루트 `.env.example`은 공개 예제이지만 이 목록에서는 설정 변경을 검토하도록 보수적으로 표시한다.

- `**/.env*`
- `.data/**`
- `.backups/**`
- `node_modules/**`
- `.git/**`

## 판단 필요 추가

제품 결정이 필요한 계약·projection 버전 변경과 사용자 데이터에 대한 작업은 선택지와 근거를
보고한다. 내부 계약의 명확한 구현 오류는 모든 소비자·테스트·생성 스키마를 함께 검증해 고칠 수
있으며 contracts 전체를 금지 경로로 취급하지 않는다. 이 프로필은 Claude의 `GOAL.template.txt`나
`WEEKLY.md`를 그대로 실행하기 위한 설정이 아니다. Codex 스킬로 요청된 범위만 수행한다.

## 검사·변이 명령

`run`은 항상 snapshot을 작업 디렉터리로 사용한다. 아래 명령은 각각 따로 실행하고 종료 코드를
확인한다. 기본 품질 게이트는 lint·format·typecheck·test·schema·build다.

```powershell
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm lint
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm format:check
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm typecheck
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm test
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm schema:game:check
python -B -X utf8 $sweepTool run --sandbox $sweepSnapshot -- pnpm build
```

패키지 의존성·export 변경은 `pnpm test:architecture`, hot path는 `pnpm performance`, 분석 성능은
`pnpm performance:analytics`를 추가한다. 일반 `pnpm test`의 DB skip은 integration 통과가 아니다.
targeted 실행은 `run --sandbox $sweepSnapshot -- pnpm exec vitest run` 뒤에 실제 `.test.ts` 경로를
한 개 이상 지정한다. watch·임의 config·추가 shell 명령은 허용하지 않는다.

변이는 `mutate --sandbox $sweepSnapshot --file` 뒤에 실제 `.ts/.tsx` 경로와 `--old`, `--new`를 주고,
`-- pnpm exec vitest run` 뒤에 해당 회귀 테스트 파일을 지정한다. 치환은 UTF-8 바이트 기준 한 곳이며
LF·CRLF·한글을 보존한다. 원본 checkout은 수정하지 않는다. 정상 테스트가 먼저 통과해야 하고,
실패·예외·timeout 후 snapshot 파일을 원래 바이트로 복원한다. 강제 종료 시에는 snapshot만 오염될 수
있으므로 재사용 전 확인한다. CAUGHT는 올바른 단언 실패인지 확인해야 하며 문법·import 오류는
증거가 아니다. MISSED는 종료 코드 1, 도구·기준선 오류는 2다. 진단 로그는 snapshot에만 보관한다.

도구 회귀 검사는 `python -B -X utf8 scripts/quality-sweep.test.py`다. POSIX `fcntl`, `free`, WSL,
Claude transcript·Stop/PreToolUse 훅·사용량 파일·별도 GUI 설치에 의존하지 않는다.

## 재점검과 완료 보고

범위 전체를 다시 확인하고 그 재점검에서 수정한 diff의 호출부·회귀 테스트를 사후 점검한다.
새 높음 0건, 사후 점검 새 높음·중간 0건, 필요한 검사 통과와 미해결 항목의 명확한 분류가 완료
조건이다. 한도·환경 문제로 멈췄으면 완료라고 쓰지 않는다. 반복 실패의 근거와 재개 지점을 남긴다.

보고에는 기준 HEAD·snapshot, 살펴본 영역, 확인/기각/수정/판단 필요 건수, 실제 명령·종료 코드,
integration skip·브라우저 미확인 같은 한계, 기존 사용자 변경과 이번 patch의 구분을 포함한다.
마지막 `verify` 결과와 Git 상태를 확인한다. 원본을 의도적으로 수정했다면 새 snapshot에서 최종 검사를
하고 그 patch만 검토한다. 기존 dirty 상태가 남는 것이 정상이며 clean 상태를 만들려고 되돌리지 않는다.
