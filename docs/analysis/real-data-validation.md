# 실제 수집 자료 검증

`pnpm analysis:validate`는 실행 중 DB의 일관된 읽기 전용 `pg_dump`를 **새로 만든 빈 PostgreSQL**에
stream으로 복사한다. 운영 volume이나 `.data`를 mount하지 않으며 운영 API를 중지하지 않는다.
이것은 분석용 DB snapshot이다. 운영 workspace와 짝을 이룬 backup/restore를 대체하지 않는다.

```powershell
pnpm analysis:validate --source-container kbo-workbench-db-1 --source-user kbo --source-database kbo
```

원본 container/user/database는 반드시 명시한다. 도구가 고유 container·anonymous volume과
localhost 임시 포트를 만들고, `analysis/validation/<UUID>/`에 실행 상태·원문 증거·모델·보고서를
저장한다. DB에는 `0012_competition_game_links`까지 migration을 적용한다. 기존 DB나 비어 있지
않은 DB에 snapshot을 덮어쓰지 않는다. 원본의 비밀번호나 `.env`를 읽어 출력하지 않는다.

## 단계와 재개

1. 동일 snapshot으로 전체 DB를 복사하고 migration·planner 통계를 준비한다.
2. 2020–2025 공식 일정 36페이지씩을 기존 제한된 HTTP adapter로 수집하고 원문 hash와 분류를 보존한다.
3. 미분류·시범·정규·포스트시즌을 집계한다. 6개 시즌 모두 확인된 정규시즌 표본이 있어야 학습한다.
4. RE24, 카운트 RE, 승리확률, 구장 효과, 구종 기대 효과를 **한 작업씩** 기존 maintenance CLI로 학습한다.
5. 모델 파일을 다시 strict decode하고 동일 repository·worker로 30회 조회 및 SQL 실행계획을 측정한다.
6. `report.md`, `benchmark.json`, 모델별 `.log`, 불변 모델 파일에 결과를 남긴다.

```powershell
# 사본·분류까지만 준비
pnpm analysis:validate --source-container kbo-workbench-db-1 --source-user kbo --source-database kbo --prepare-only
# 같은 실행을 이어서 수행
pnpm analysis:validate --resume analysis/validation/<UUID>
# 분석 코드를 바꾼 후 전체 모델을 다시 학습; 이전 실행 로그와 모델은 보존
pnpm analysis:validate --resume analysis/validation/<UUID> --rerun-models
# 학습한 모델을 유지하고 조회/적용/실행계획만 다시 측정
pnpm analysis:validate --resume analysis/validation/<UUID> --measure-only
# 그 실행이 소유한 DB container와 anonymous volume만 정리; 보고서·모델은 유지
pnpm analysis:validate --resume analysis/validation/<UUID> --cleanup
```

재개와 정리는 저장된 container ID·고유 이름·소유 label을 모두 대조한다. snapshot 복사 도중
실패해 DB가 일부 채워졌다면 기존 실행을 정리한 후 새로 시작한다. 학습 실패는 모델 포인터를
공개하지 않는다. 검증 DB는 결과 확인과 실패 진단을 위해 자동 삭제하지 않는다.
같은 실행의 재개·정리는 `run.lock`으로 직렬화한다. 비정상 종료 후 lock이 남으면 기록된
host/PID가 종료됐는지 확인한 뒤 그 실행의 lock만 제거한다. 빌드한 코드 hash가 달라졌으면
완료된 모델을 조용히 재사용하지 않고 명시적인 `--rerun-models`를 요구한다.
조회 코드만 바꿨을 때의 `--measure-only`는 migration·분류·학습을 실행하지 않는다. 기존 모델을
strict decode하고 현재 원천 manifest를 다시 검증한다. 학습 당시 `codeHash`는 보존하고
측정 코드의 `measurementCodeHash`를 별도로 기록한다.

## 경기 ID 연결

KBO 일정의 ID와 수집된 Naver ID는 형식이 다르다. `collection/kbo-game-links.ts`가 명시적인
제공자 ID 형식을 해석한다. 실제 경기일, 원문 ID의 월일·원정/홈 팀 코드·더블헤더 순번,
Naver의 시즌 suffix가 모두 일치하고 후보가 하나일 때만 연결한다. 특수 prefix로 경기 종류를
추정하지 않는다. 종류는 공식 일정 페이지에서만 얻는다. 알 수 없는 형식·연결 없는 경기는 미분류다.

`reference.competition_game_links`에 두 원본 ID를 함께 보존하고 dataset hash에 연결을 포함한다.
저장소는 현재 경기 목록으로 날짜·대상·중복을 다시 검증한다. 봉인한 분류와 연결은 불변이며 기존
sealed 경기 fact를 교정하지 않는다. 직접 ID가 일치하는 기존 dataset의 읽기·hash는 유지한다.

## 성능과 해석

학습 로그의 `phasesMs`는 입력 조회/계산/저장을 분리한다. 조회에는 snapshot·hydration,
계산에는 worker 전송이 포함된다. RSS는 worker를 포함한 프로세스 값을 100ms 간격으로 관측한다.
순간 peak를 모두 잡는 상한값은 아니다. 여러 학습을 동시에 실행해 메모리를 증폭시키지 않는다.

조회 측정은 2025년 최다 실제 투구 투수와 시즌 집계·한 경기 가치를 사용한다. 모델 없는 입력
조회와 준비된 파일을 검증·적용하는 조회를 구분한다. 첫 실행도 OS/PostgreSQL cache를 비우지
않았으며 HTTP·화면 렌더링은 제외한다. 선수·모델 hash·SQL hash·실행계획은 JSON에 기록한다.
모든 선수와 동시 사용자 부하의 지연 상한으로 해석하지 않는다.

후보·채택 기준은 기존 계획을 유지한다. 2023/2024로 선택하고 2025로 평가한다. 미채택 결과도
정상이며 2025 결과를 보고 문턱을 낮추지 않는다. 승리확률은 적용 연도의 상한으로 과거 경기의
학습용 종료를 재구성하고, 2025 실제 결과는 선택이 끝난 모델의 평가에만 사용한다.
구장 보정 연구에서 이미 2025를 살펴봤으므로 전체 체계의 완전히 독립된 holdout이라고 부르지 않는다.

이 도구는 운영 배포·운영 분류 채택·모델 복사를 실행하지 않는다. 운영 적용은 검증 보고서와 원천
manifest를 확인한 뒤 기존 paired backup·writer lock 절차에 따라 별도로 수행한다.

## 전체 투수와 HTTP 회귀 점검

`analysis:audit`는 위에서 준비한 격리 DB의 소유 label·container ID·localhost 포트를 다시 확인하고
같은 `run.lock`을 사용한다. DB 연결은 읽기 전용이며 새 migration·외부 수집·모델 학습을 실행하지 않는다.
원천 workspace는 읽기만 하고, 첫 품질 조회가 생성하는 보정 캐시는 새 audit 디렉터리에만 저장한다.

```powershell
pnpm analysis:audit --run analysis/validation/<UUID>
pnpm analysis:audit --run analysis/validation/<UUID> --baseline analysis/validation/<UUID>/audits/<이전-UUID>
# 모델 없이 전체 운용 비교만 검증
pnpm analysis:audit --run analysis/validation/<UUID> --mode workload
# HTTP 측정만 별도로 실행
pnpm analysis:audit --run analysis/validation/<UUID> --mode queries
# 일부 시즌으로 좁힌 운용 검증은 전체 시즌 검증과 구분한다
pnpm analysis:audit --run analysis/validation/<UUID> --mode workload --seasons 2024,2025
```

- 기본 운용 범위는 2020–2025 확인된 정규시즌의 모든 선수·시즌이다. 실제 투구 0개인 등판도 포함한다.
  독립 pitch fact 집계와 결과의 실제 투구 수를 대조하며, 역할 근거·항목별 제외 합계·지표별 분모·
  확률 범위·공통 표본·보류 정책을 검증한다. 모든 선수를 입력 순서 반전 후 다시 계산한다.
- 소표본과 불안정한 재표집은 정상 상태로 집계한다. 기존 문턱을 낮추거나 다중 비교 유의성 순위를
  만들지 않는다. `workload.ndjson`에 개별 응답을 보존하므로 극단값도 근거·표본과 함께 조사할 수 있다.
- HTTP 측정은 항상 2025 최다 실제 투구 투수를 사용한다. 품질·구종 기대 효과·운용 비교의 실제
  route와 worker 1개/대기 16개, DB 연결 최대 4개를 localhost 임시 포트에 조립한다. 2025용 구종 모델이
  필요하다. 화면·프록시·인증·운영 서버 시작 비용을 포함하는 전체 서비스 부하 시험은 아니다.
- 각 조회는 첫 요청과 이후 30회, 동시 요청은 품질·구종·운용·구종 4건씩 10묶음을 측정한다.
  OS/DB cache는 비우지 않는다. 운용 HTTP 연결 취소가 worker signal에 도달하는지와 후속 정상 응답을
  확인한다. CPU 계산 중단과 SQL 중단은 다르며 실행 중 DB 문장은 기존 30초 상한을 유지한다.
- 시작·종료 원천 지문이 다르거나 한 선수라도 검증에 실패하면 명령은 실패로 종료한다. Ctrl+C도
  취소 상태로 기록한다. 부분 결과를 완료 기준으로 재사용하지 않는다. 기존 실행 결과를 덮어쓰지 않는다.
- 기준 실행과 비교하려면 시즌·모드·원천·선수 목록·모델이 같아야 한다. 원천 변경과 응답 변경,
  누락·추가 선수를 구분하고 차이가 있으면 실패로 보고한다. 코드 hash는 비교를 위해 달라도 된다.

`audit.json`에 상태·코드/원천 hash·선수별 응답 hash·시즌별 지원 비율·시간·25ms 간격 Node RSS를,
`query-plans.json`에 느린 SQL 5개의 실제 실행계획을 저장한다. 첫 품질 조회는 새 보정 캐시 생성 비용을
포함한다. RSS는 부모와 worker를 포함하고 DB는 제외하며 순간 최고 사용량의 상한은 아니다.
검증 도구 자체의 회귀 검사는 `pnpm test:analysis-validation`로 실행한다.

품질 GET이 202를 반환하면 audit은 준비 상태를 검증하며 완료까지 polling한다. 기존 첫 요청 시간은
완료까지의 총 시간으로 유지하고 `acceptedMs`, `preparationPolls`를 별도 기록한다. 새 route의
메모리 cache 없이 저장 요약을 재사용하는 `coverageRestart`도 검증한다. 저장 요약과 보정은 해당
새 audit 디렉터리의 `cache/`에만 생성하며 검증 원천 workspace는 수정하지 않는다.
