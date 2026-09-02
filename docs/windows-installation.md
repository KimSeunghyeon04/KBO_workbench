# Windows Docker Desktop 설치

이 문서는 새 Windows 환경에서 V2 원장/API를 유지하는 KBO Workbench DB V3를 재현하는 절차다. 사용자 기능 실행에 Node,
Python 또는 전역 CLI 설치는 필요하지 않다.

## 준비

- Windows 11 또는 지원되는 Windows 10
- WSL 2 backend를 사용하는 최신 Docker Desktop
- Git
- 저장소와 경기 자료를 둘 충분한 로컬 디스크 공간

Docker Desktop에서 Linux container 모드를 사용한다. web과 PostgreSQL만 `127.0.0.1` port에
공개되고 API는 Docker 내부 network에 남는다. DB 기본 host port는 `5433`이다.

## 최초 설치

PowerShell에서 저장소를 받은 뒤 root로 이동한다.

```powershell
git clone <repository-url> KBO_workbench
Set-Location KBO_workbench
Copy-Item .env.example .env
```

`.env`에서 다음 값을 확인한다.

- `POSTGRES_PASSWORD`: 다른 곳에서 사용하지 않는 충분히 긴 로컬 password
- `KBO_DATA_DIR`: original과 staging 현재 상태를 둘 경로. 기본 `./.data` 또는 전용 절대 경로
- `KBO_WEB_PORT`: 기본 `8080`; 이미 사용 중이면 다른 localhost port
- `KBO_DB_PORT`: DBeaver·R·Jupyter가 접속할 localhost port, 기본 `5433`
- `KBO_ANALYST_USER`, `KBO_ANALYST_PASSWORD`: `analytics` 전용 read-only 계정

설정을 확인하고 시작한다.

```powershell
docker compose config
docker compose up -d
docker compose ps
```

`migrate`는 one-shot으로 종료되고 `db`, `api`, `web`이 healthy여야 한다. 브라우저에서
<http://127.0.0.1:8080>과 `/settings`를 열어 API, PostgreSQL 16, migration, workspace와 Playwright
상태를 확인한다.

## 평소 운영

```powershell
docker compose up -d
docker compose logs -f api
docker compose down
```

일반 중지와 재시작은 volume과 bind-mounted workspace를 보존한다. `docker compose down -v`는
PostgreSQL volume을 삭제하므로 폐기 작업이 아니면 실행하지 않는다.

업데이트 전에는 [백업과 복원 운영](backup-and-restore.md)에 따라 backup을 만들고 다음 순서로
이미지를 갱신한다.

```powershell
git pull --ff-only
docker compose build
docker compose up -d
docker compose ps
```

## 깨끗한 환경 확인

개발 또는 배포 검증 환경에서는 다음 명령으로 사용자 data와 분리된 전체 recovery E2E를 실행할
수 있다.

```powershell
pnpm test:e2e
```

이 명령만 개발용 Node/pnpm을 요구한다. 일반 사용 환경에서는 Docker Compose 명령과 웹 화면만
사용한다.
