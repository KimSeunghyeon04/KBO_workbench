# 백업과 복원 운영

backup은 PostgreSQL만 또는 staging 파일만 따로 복사하지 않는다. 최초 정리 원장과 staging 현재
상태는 workspace에 있고, 적재 후 최종 typed revision은 PostgreSQL에 있으므로 두 저장소를 한
backup 단위로 묶는다.

`.data/collection`의 일정 원문·정규화 결과·확정 선택·작업 요약·경기별 결과도 workspace ZIP에 포함한다.
별도 export 없이 기존 전체 workspace 백업/복원 경로를 사용한다. 재시작/복원 시 중단된 수집 작업은
완료 결과와 요청 키를 유지한 채 중단으로 표시하며 자동 재실행하지 않는다. hash 검증에 실패한
수집 기록은 임의로 고치거나 재작성하지 말고 해당 파일과 정상 백업을 확인한다.

## Backup 만들기

`.data/imports`도 전체 workspace 백업에 포함한다. `selections`는 확정 문서 hash/base 집합,
`batches`는 한 번 기록한 전체 대기 의도, `jobs`는 경기별 진행·결과·idempotency다. 복구 시 실행 중
작업의 정확한 DB revision/hash를 확인해 저장 성공 또는 중단으로 기록한다. DB 저장 뒤 파일 정리만
남았다면 정리만 재시도한다. 업그레이드 직전 조회한 실제 완료 이력은 `retained`에 불변 보존할 수 있다.
이전 서버의 알 수 없는 요청 키나 이미 사라진 결과는 추정하지 않는다. 이력 hash 손상은 시작을 차단한다.

저장소 root에서 실행한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
```

기본 위치는 `.backups/kbo-workbench-<UTC timestamp>`다. 다른 디스크를 사용하려면 절대 경로를
지정할 수 있다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1 `
  -DestinationRoot D:\KBO_Backups
```

스크립트는 다음 순서로 동작한다.

1. Compose가 실제 사용하는 workspace bind mount와 DB 사용자/이름을 해석한다.
2. 실행 중이던 web과 API를 정지해 workspace writer를 닫는다.
3. PostgreSQL custom-format dump와 workspace ZIP을 생성한다.
4. 각 파일의 SHA-256, app/migration version과 생성 시각을 `manifest.json`에 기록한다.
5. backup 전 실행 중이던 서비스만 다시 시작한다.

Windows bind mount에 원문과 과거 artifact가 많이 쌓이면 재시작 시 디렉터리 점검에 시간이
걸린다. API healthcheck의 시작 유예는 180초이며, 실제 무결성 검사가 끝나기 전의 readiness는
503을 유지한다. 백업 후 서비스 재시작만 실패한 경우에도 백업 manifest와 두 파일의 hash를
먼저 확인하고, 백업 생성 실패와 재시작 실패를 구분해 진단한다.

backup 디렉터리에는 다음 세 파일이 있어야 한다.

```text
manifest.json
postgres.dump
workspace.zip
```

app/migration 값은 현재 checkout의 기대값이 아니라 실제 실행 중인 API와 DB에서 읽는다. 따라서 V2
source가 실행 중인 상태에서 V3 코드를 checkout했더라도 V2 backup manifest가 잘못 V3로 표기되지
않는다. `.data/registry/source`, `.data/record-corrections/source`와 V3 current export artifact도
workspace ZIP에 함께 포함된다.

## Restore

복원은 현재 workspace와 PostgreSQL 내용을 backup 시점으로 교체한다. 경로만 전달해서 실수로
실행할 수 없도록 `-ConfirmDataReplacement`가 필수다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore.ps1 `
  -BackupDirectory D:\KBO_Backups\kbo-workbench-20260822T010203000Z `
  -ConfirmDataReplacement
```

복원기는 변경 전에 두 backup 파일의 SHA-256을 manifest와 비교한다. workspace ZIP은 같은
filesystem의 임시 디렉터리에 먼저 풀고 API를 정지한 뒤 directory rename으로 교체한다. DB는
`pg_restore --clean --single-transaction`으로 복원하므로 SQL 오류가 발생하면 기존 DB transaction을
유지한다. DB 복원이 실패하면 교체 전 workspace도 원래 위치로 되돌린다. 성공 후에는 실행 중이던
web/API만 다시 시작한다.

복원 후 다음을 확인한다.

```powershell
docker compose ps
Invoke-RestMethod http://127.0.0.1:8080/health/ready
```

Settings의 PostgreSQL major/V3 `4/4/1/2` 계약, 경기 catalog, 기록정정 current source revision,
current game revision과 replay hash도 확인한다.

`0004_pitch_metadata` 배포 전에도 API writer를 멈춘 같은 시점의 DB와 workspace backup을 먼저
만든다. migration은 transaction으로 적용하며 실패하면 rollback하고 API를 시작하지 않는다. DB만
이전 시점으로 되돌리거나 `.data/record-corrections/source`만 교체하면 provenance 쌍이 깨지므로 항상
동일 backup 단위로 복원한다.

## Workspace current manifest migration

versioned current manifest가 없는 legacy workspace와 V1 current manifest는 먼저 read-only로 검사한다.

```powershell
pnpm workspace:migrate -- --dry-run
```

적용은 API/writer를 멈추고 같은 시점에 만든 `manifest.json`, `postgres.dump`, `workspace.zip`의 hash가
검증되는 backup 경로를 명시해야 한다. 실제 운영 workspace에는 별도 승인 없이 실행하지 않는다.

```powershell
pnpm workspace:migrate -- --apply --backup D:\KBO_Backups\kbo-workbench-<timestamp>
```

staging, quarantine, source-failure가 겹치거나 기존 current manifest와 충돌하면 도구는 우선순위를
추측하지 않는다. dry-run 결과의 정확한 legacy 상대 경로를 선택한 resolution 파일이 있어야 진행한다.
legacy 파일은 삭제하지 않고 `migration-archive`로 옮긴다.

dry-run은 legacy artifact 외에 V1 manifest 수, source failure 수, 파생 가능한 표시 요약 수와 manifest
검증 실패를 보고한다.
ready/quarantine V1은 가리키는 artifact와 finding envelope의 content/document hash를 확인하고 strict
원장에서 경기일·대진 요약을 만든다. source failure는 표시 요약을 null로 유지한다. apply는 manifest
upgrade journal을 먼저 쓰고 current를 atomic replace한 뒤 journal을 제거하므로 startup에서
idempotent하게 roll-forward할 수 있다. artifact bytes와 hash는 바꾸지 않는다.

## V2에서 V3로 전환할 때

V2 current-only export를 시작하기 전에 이 backup을 먼저 만들고 결과 디렉터리를 그대로 보존한다.
전환 도구는 V2 최종 migration이 기록된 backup manifest와 database/workspace hash를 다시 검사한다.
이후 API/writer를 중지하고 journal이 비어 있을 때만 export한다. V3는 별도
`kbo-workbench-postgres-v3` volume에 적재하며 기존 V2 volume을 삭제하거나 truncate하지 않는다.

V2 volume을 별도로 확인할 때는 다음처럼 명시적으로 연다.

```powershell
docker compose -f compose.v2-legacy.yaml up -d db-v2
```

`KBO_V2_VOLUME_NAME`이 실제 legacy volume 이름과 일치하는지 먼저 확인한다. 일반 종료는 같은 compose
파일의 `down`만 사용하고 `-v`를 붙이지 않는다. 자세한 export/load/verify 순서는
[PostgreSQL persistence 운영](postgresql-persistence.md)에 있다.

## 손상·실패 처리

- manifest가 없거나 format version이 다르면 복원을 시작하지 않는다.
- dump/ZIP hash가 다르면 서비스를 멈추기 전에 거부한다.
- filesystem root를 workspace로 해석하면 backup과 restore를 거부한다.
- restore 도중 생성하는 경로는 workspace의 sibling으로 제한한다.
- 일반 종료에 `docker compose down -v`를 사용하지 않는다. 이 명령은 backup이 아니라 DB volume
  삭제다.

backup은 애플리케이션과 같은 디스크 하나에만 두지 말고 주기적으로 다른 물리 디스크에도
복제한다. 복사 뒤에도 `manifest.json`과 두 파일을 한 디렉터리 단위로 유지한다.

## 자동 복구 검증

다음 명령은 고유 project name, 임시 workspace, 임시 PostgreSQL volume과 localhost 임시 port를
사용한다. golden staging 경기 적재, 중단 journal 복구, replay, backup, 의도적 staging 삭제와 DB
schema 제거, restore, API restart 후 hash 일치를 검증한 뒤 자신이 만든 자원만 삭제한다.

```powershell
pnpm test:e2e
```

실제 사용자 `.data`와 기본 Compose volume은 이 검증의 대상이 아니다.
