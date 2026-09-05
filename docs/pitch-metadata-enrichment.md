# 구속·구종 자동 수집과 일회 보완

앞으로 수집하는 경기의 구속·구종은 Naver 투구 행에서 자동으로 전달된다. 기존 데이터 보완은
이 문서의 maintenance CLI로 한 번 수행한다. 웹 보완 버튼이나 자동 보완 스케줄러는 두지 않는다.

## 적용 대상과 보존

- 기본 대상은 모든 보유 시즌의 current 작업 문서와 DB current revision이다.
- staging/quarantine 작업본이 있으면 그 문서에만 structured correction batch를 적용하고 기존
  writer lock·base hash·journal 경로로 commit한다. DB revision과 작업본의 revisionBase를 유지한다.
- 작업본 없는 DB 경기는 current를 초안으로 읽고 전체 검증 후 current+1로 봉인한다.
- 원문 bundle 및 endpoint gzip hash를 확인하고 `endpoint + blockIndex + eventIndex`로 원천 행을
  찾는다. 배열 재정렬·삭제와 non-unique pitch ID로 다른 투구를 채우지 않는다.
- 현재 남은 투구의 빈 값만 채운다. 기존 값 충돌, 수동 행, 원천 위치/선수 문맥 불일치와 누락·손상
  원문은 덮어쓰지 않고 보고한다. 구종은 제공 명칭을 보존한다.
- 구속·구종을 제거한 원장과 compiler 전체 결과가 전후 동일해야 적용한다. 경기별 순차 처리하며
  DB 오류는 transaction rollback한다. 파일 commit은 기존 crash-recovery journal을 사용한다.
- 값 변경이 없으면 건너뛰므로 재실행해도 중복 revision을 만들지 않는다. original, superseded,
  원천 취득 실패 및 과거 revision은 대상에서 제외한다.

## 실행 순서

코드의 품질 게이트, architecture, integration, E2E와 performance를 먼저 통과시킨다. 운영 API와
수집 writer를 멈추고 미완료 journal이 없음을 확인한 뒤 workspace·DB 쌍을 백업한다.

```powershell
docker compose stop web api
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
docker compose build
docker compose run --rm migrate
```

backup 스크립트는 실행 전 이미 중지된 API를 다시 시작하지 않는다. 아래 `<backup-dir>`는 방금
생성한 `manifest.json`, `postgres.dump`, `workspace.zip`이 있는 절대 경로로 바꾼다. 적용은 두 파일의
SHA-256과 manifest의 DB 이름을 검증하며 `--backup`이 없으면 거부한다.

```powershell
docker compose run --rm --no-deps api node apps/server/dist/maintenance/enrich-pitch-metadata.js --dry-run
docker compose run --rm --no-deps -v "<backup-dir>:/backup:ro" api node apps/server/dist/maintenance/enrich-pitch-metadata.js --apply --backup /backup
docker compose run --rm --no-deps api node apps/server/dist/maintenance/enrich-pitch-metadata.js --dry-run
docker compose up -d api web
```

환경 변수를 갖춘 개발 shell에서는 `pnpm maintenance:enrich-pitch-metadata -- --dry-run` 또는
`--apply --backup <backup-dir>`도 사용할 수 있다. `--season <year>`, `--workspace <dir>`,
`--report <new.jsonl>`로 범위를 제한하거나 경로를 지정한다. 모드는 반드시 하나를 명시한다.
writer lock이나 미완료 journal이 있으면 시작을 거부한다. journal이 남은 장애는 정상 writer의
기존 roll-forward recovery 후 재실행한다. 작업본을 자동 import하지 않는다.

## 결과 확인

기본 보고서는 workspace의 `logs/pitch-metadata-<UTC>.jsonl`이다. 경기마다 즉시 기록하며
authority, source hash, 변경 투구 수, 전후 구속·구종 충족률, 새 revision, 건너뛴 사유와 정확한
원천 위치/warning을 포함한다. 실패 경기도 기록한 후 다른 경기를 계속 처리하고 exit 1을 반환한다.
완료 summary의 충족률 분모는 읽기·검증에 성공한 현재 투구 원장 행 수이며 실패 경기는 별도 집계다.

적용 후에는 과거 revision manifest와 projection/replay hash, current 수, 원장 수와 기본 경기
통계를 전후 비교한다. 재실행 미리보기의 변경 수가 0인지, `analytics.current_pitches`의 새 컬럼과
재생 화면이 일치하는지 확인한다. 미제공 데이터는 추측으로 채우지 않는다.

## 2026-09-05 운영 적용 결과

784경기를 검사해 779경기, 240,096개 투구를 보완했다. 실패는 0건이다.

| 범위                                  | 보완 경기 | 보완 투구 | 구속·구종 충족률 |
| ------------------------------------- | --------: | --------: | ---------------: |
| DB current (전체 241,647개 투구 기준) |       778 |   239,773 |      각각 99.22% |
| 진행 중인 staging 작업본              |         1 |       323 |        각각 100% |
| 작업본을 우선한 전체 현재 원장        |       779 |   240,096 |      각각 99.36% |

값을 채울 수 없는 5경기는 revision을 추가하지 않았다. 원천의 유효하지 않은 구속·미제공 구종
1,519개 투구와 수동 행 32개는 보존했다. 작업본 1경기의 DB current와 revisionBase도 유지했다.
상세 원천 위치와 warning은 [적용 JSONL](../.data/logs/pitch-metadata-apply-20260905.jsonl)에 있다.

기존 784개 revision의 manifest·document/projection/frame hash와 모든 경기의 기본 계산 결과가
전후 동일했다. 원문·original·기존 superseded 12,096개 파일과 작업본의 metadata 외 내용도
동일했다. DB revision은 총 1,562개이며 미봉인 revision은 0개다.
[전후 검증 결과](../.data/logs/pitch-metadata-after-20260905.json)와
[재실행 결과](../.data/logs/pitch-metadata-rerun-20260905.jsonl)를 보존했다. 재실행의 추가 변경은 0건이다.

백업은 `.backups/kbo-workbench-20260905T065309858Z`에 보관했다. migration 전 `3/3/1/2` DB와
workspace 쌍의 SHA-256을 확인한 뒤 적용했다. 서비스 재시작 후 API·웹·DB healthy와 실제 재생
화면의 구종·구속 표시를 확인했고 브라우저 오류는 0건이었다.

lint, format, typecheck, schema, build, unit 449개, architecture 17개, 격리 PostgreSQL 12개와
Compose E2E를 통과했다. compiler 성능은 평균 0.834ms, p95 1.063ms였다. 컨테이너 PID 재사용 시
writer lock 복구와 이미 중지된 서비스의 백업 오류도 수정·검증했다.
