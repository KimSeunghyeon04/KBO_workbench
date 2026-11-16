# Makefile로 운영 배포

저장소 루트의 Makefile은 기존 `compose.yaml`과 `scripts/backup.ps1`을 실행한다.
Docker Compose v2와 GNU Make가 필요하다. 백업에는 Windows PowerShell 또는 PowerShell 7이
필요하며, Linux/macOS에서는 `pwsh`를 사용한다. Windows에서도 `make --version`이 실행되는
터미널에서 사용한다. Make가 없는 환경에서는 [Windows 설치 절차](windows-installation.md)의
Docker Compose 명령을 직접 사용할 수 있다.

## 최초 배포

```sh
make init
# .env의 DB/분석 계정 암호, 자료 경로와 포트를 설정한다.
make deploy
make status
```

`make init`은 기존 `.env`를 덮어쓰지 않는다. Docker Desktop은 Linux container 모드로 시작한다.
`make deploy`는 설정·Docker 연결 확인, API/web 이미지 빌드, 기존 web/API 정지, migrate/API/web
교체와 준비 상태 확인을 순서대로 실행한다. migrate는 새 이미지로 다시 생성하며 DB migration이
성공해야 API를, API가 healthy여야 web을 시작한다. 빌드 실패 시 기존 서비스는 계속 실행된다.

API는 `pwuser`로 실행하고 `/app`의 빌드 결과는 읽어서 사용한다. 쓰기는 파일 워크스페이스와
임시 디렉터리에 한정하므로 이미지 빌드에서 `/app` 전체의 소유권을 재귀 변경하지 않는다.

기본 접속 주소는 <http://127.0.0.1:8080>이며 `.env`의 `KBO_WEB_PORT`를 바꾸면 해당 포트로 접속한다.
준비 상태는 기본 300초까지 기다린다. 자료가 많아 시작 검증이 오래 걸리면
`make deploy WAIT_TIMEOUT=600`처럼 늘린다. `migrate`의 정상 상태는 `Exited (0)`이고
`db`, `api`, `web`은 `healthy`여야 한다.

## 운영 업데이트

수집·적재 작업을 끝내고 보정 내용을 저장한 뒤 실행한다.

```sh
make update
```

새 이미지를 먼저 빌드하고, 기존 백업 스크립트로 DB dump와 workspace ZIP을 함께 만든 뒤
배포한다. 백업은 writer를 정지하고 SHA-256 manifest를 기록하며 기존 서비스의 실행 상태를
복구한다. 백업 명령이 실패하면 업데이트를 중단한다. 운영 DB가 아직 없는 최초 설치는
`make deploy`를 사용한다. `make deploy` 자체는 백업을 만들지 않는다.

백업 스크립트는 실행 중 API와 checkout의 app version이 같은지 검사한다. app version이 바뀌는
업데이트에서는 **checkout 변경 전에 `make backup`**을 실행하고, 새 코드를 받은 뒤
`make deploy`로 반영한다. 버전 검사 실패를 무시하거나 backup manifest를 수정하지 않는다.

마이그레이션·준비 상태 실패 시 명령은 실패로 종료한다. 자동으로 DB를 되돌리거나 이전 API를
시작하지 않는다. `make status`와 `make logs SERVICE=migrate` 또는 `make logs SERVICE=api`로
원인을 확인한다. 복원이 필요하면 [백업과 복원 운영](backup-and-restore.md)의 검증 절차를 따른다.

## 자주 쓰는 명령

| 명령                                      | 동작                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `make` / `make help`                      | 명령 목록                                                |
| `make config`                             | 비밀값을 출력하지 않고 Compose 설정 검증                 |
| `make build`                              | 서비스 중단 없이 API/web 이미지 빌드                     |
| `make up`                                 | 기존 이미지로 서비스 시작 및 준비 상태 확인              |
| `make restart`                            | 기존 이미지로 API/web 재시작 및 준비 상태 확인           |
| `make status`                             | 종료한 migrate를 포함한 컨테이너 상태                    |
| `make logs SERVICE=web TAIL=200`          | 지정 서비스의 최근 로그와 이후 로그                      |
| `make stop`                               | 컨테이너를 남기고 서비스 중지                            |
| `make down`                               | 컨테이너·네트워크 제거, DB volume과 workspace 보존       |
| `make backup BACKUP_DIR="D:/KBO Backups"` | 지정 위치에 DB/workspace 쌍 백업                         |
| `make check`                              | lint, format, typecheck, test, schema, build 순서로 검증 |

배포는 Git checkout을 변경하지 않으며 현재 작업 트리의 코드로 이미지를 만든다. 빌드·배포에는
호스트 Node/pnpm이 필요하지 않다. `make check`에는 Node.js 24와 pnpm 10.15.1이 필요하며,
DB 통합·E2E 검증은 변경 범위에 따라 별도로 실행한다.

모든 명령과 백업은 `COMPOSE_FILE=compose.yaml`을 공유한다. 기본 운영 project와 `.env`의
workspace/volume/localhost 포트 설정을 사용하며 개발용 Compose 파일을 섞지 않는다.
한 번의 make 실행은 `-j`를 주어도 직렬로 처리하지만, 서로 다른 터미널에서 배포·백업 명령을
동시에 실행하지 않는다. 데이터 삭제·초기화·복원 target은 제공하지 않는다.
