# 분석 기능 구현 계획

## 1. 작업 방식

이 계획은 기능별로 동작하는 결과를 순서대로 추가한다. 공통 플랫폼을 만드는 선행 프로젝트는 없다.
각 PR은 해당 기능의 계약·SQL/계산·API·화면·테스트·문서를 함께 끝내며 사용자 데이터 재적재를 요구하지 않는다.
아래의 파일명·경로는 새로 만들 후보이며 현재 존재한다는 뜻이 아니다. 기존 파일은 명시적으로 구분한다.

## 2. 단계와 통과 조건

| 단계 | 작업과 배포 가능한 결과                                                              | 다음 단계 진입 조건                                       |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 0    | A01a: 수집 범위·누락률·경기 종류 근거 확인. A03 기존 결과에 최소 표본 표시           | current-only, 표본 합계, 원천/보정 좌표 구분 검증         |
| 1    | A01b: 경기 종류 보완·필터. A03: 2020–2025 프로필. A07: 기존 선구안의 동일 scope 적용 | 경기 종류 변경이 기준/캐시에 반영되고 기존 계산 회귀 통과 |
| 2    | A02: 성적. A04: 투수 코스. A05: 변화. A08: 타자 약점                                 | 투구/타석 중복 없음, 비교 기간·분모·소표본 정책 일치      |
| 3    | A06: 배합. A09a: 기술 통계 매치업. A12: 운용. A13a: 주루 집계                        | 순서·관측 공백·identity·더블헤더·atomic play 검증         |
| 4    | A11a: RE24. A11b: 카운트 기대득점·투구 연결. A13b: 플레이 가치                       | 실제 득점과 가치 합계의 보존, 중도 종료 처리 검증         |
| 5    | A10: 기대 효과. A09b: 검증된 확률만 연결. A11c: 승리확률. A14a: 구장 효과            | 시간 검증과 단순 기준 대비 채택 조건 충족                 |
| 선택 | A14b: 과거 날씨 보조 분석                                                            | 간편 취득·구장/시간 매칭·야외 표본 조건 충족              |

A02와 A07 확장, A04와 A05 등은 선행 계약이 정해지면 독립 작업으로 진행할 수 있다. 공통 파일을
먼저 잠그기보다 각 기능의 변경 범위를 나누고 공유가 필요한 지점에서만 작은 PR로 추출한다.

## 3. 초기 단계 구현 체크

### 단계 1 — 계산 가능 범위를 보이게 한다

- [x] A01의 품질 계약과 DB 집계를 추가한다. 경기 종류는 확보된 근거만 사용하고 미상 수를 표시한다.
- [x] 실제 투구 → tracking 연결 → 유효 궤적/존/보정 가능의 수를 분리한다.
- [x] 기존 투수 화면에 대상·기준 표본과 미보정 수를 함께 보여준다.
- [x] current revision 전환과 join 중복 방지를 격리 DB에서 검증한다.
- [x] 이 단계에서는 범용 scope query builder, 모델 저장소, 외부 날씨 테이블을 만들지 않는다.

### 단계 2 — 경기 종류의 근거와 채택

- [x] A01의 일정 보완 snapshot을 검증·채택하는 명령과 typed reference 저장소를 추가한다.
- [x] 매칭 실패·충돌·부분 취득은 current 선택을 바꾸지 않고 dry-run에서 보고한다.
- [x] 품질 화면에서 경기 종류별 집계와 미분류 근거를 확인한다.
- [x] 외부 자료 연결이 막히면 미분류 상태를 유지하고 정규시즌 전체 순위를 출시하지 않는다.

### 단계 3 — 6개 시즌 투수 프로필

- [x] A03의 연도 선택을 2020–2025 수집 범위로 넓히고 기준·보정·표본에 scope를 적용한다.
- [x] scope가 바뀌어야 무효화되는 캐시와 그대로 재사용할 캐시를 각각 검증한다.
- [x] 미보정 구간·빈 기간·기준 표본을 기존 화면에 표시한다.

### 단계 4 — 선구안에 같은 경기 범위 적용

- [x] A07도 동일 경기 선택을 쓰되 source-plane 기준과 기존 존 정의는 유지한다.
- [x] 두 실제 소비자의 동일한 범위 선택만 공유하고, 기준 궤적·분모·제외는 각 기능에 둔다.
- [x] 기존 paired 표본·조건 일치 회귀와 범위 변경의 hash 무효화를 검증한다.

### 단계 5 이후 — 독립적인 기능 단위

기능별 소유 모듈로 구현했다. A11의 RE24·카운트·승리확률은 계약·계산·모델 파일을 분리하고
A14 날씨는 자료 조건 미충족으로 제외했다. A10의 분할·기준·채택 조건은 기능 문서와 코드에
고정했으며 학습 시 원천/전처리/평가 manifest를 남긴다. 모델 학습·운영 반영은
[구현 상태](implementation-status.md)와 날짜별 검증 기록을 따른다. A09b의 타자 효과와
A03의 원천 진입각 확장도 별도 계약·계산·패널로 구현했다.

## 4. 변경 소유권과 공통 작업

| 작업              | 위치                                                          | 추가 조건                                        |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| 새 query/response | `packages/contracts/src/<feature>.ts`와 명시적 barrel         | strict decode, null/단위/분모 계약               |
| 순수 계산         | `packages/game-core/src/<feature>.ts`                         | DB·파일·시간·난수의 숨은 의존성 금지             |
| 조회/보존         | `packages/persistence/src/<feature>-repository.ts` 등         | 같은 snapshot, parameterized SQL, current-only   |
| HTTP·계산 조립    | `apps/server/src/<feature>-service.ts`, `routes/<feature>.ts` | `app.ts`는 등록만, 장기 학습은 CLI부터           |
| 화면              | `apps/web/src/pages/`, `analysis/`, `api/`                    | 기존 app-shell와 URL 조건·query 관례             |
| 보조자료 취득     | `packages/collection/src/`의 자료별 adapter                   | 원본 증거 보존, fixture 검증, 사용자 조회와 분리 |
| SQL 변경          | `database/v3/`의 다음 migration                               | 실제 최신 번호 확인; 이 문서에서 번호 선점 금지  |

새 migration은 typed reference/view/index 위주다. 원장 계약이나 projection column을 바꿔야 한다면
그 필요성을 별도 결정하고 compiler·projection descriptor·hydration·hash·schema를 함께 변경한다.
이 계획의 기본 경로에는 그런 변경이 필요하지 않다.

## 5. 검증 계획

| 계층        | 완료 증거                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------- |
| 계산        | 수작업으로 확인 가능한 작은 예시, 순서/단위/null/표본 보존 invariant                              |
| DB          | revision 1→2 중 current만 반영, one-to-many join 중복 없음, 실제 typed hydration, snapshot 일관성 |
| API         | 정상·빈·소표본·미지원·잘못된 query, 응답 strict decode, 페이지·범위 상한                          |
| 캐시/worker | 관련 hash 변경에 대한 무효화, 진행 요청 공유, 실패 재시도, 취소/종료 시 부분 결과 미공개          |
| UI          | URL 복원, 이전 응답 역전 방지, null과 0 구분, 분모/단위, 모바일·키보드·근거 이동                  |
| 모형        | 시간 분할, 전처리 누수 방지, 기준 대비 성능, 확률 보정, 하위 집단, 재현 manifest                  |
| 성능        | 같은 fixture/하드웨어의 cold/warm 시간·RSS·query plan; 기존 기능 영향                             |

기존 회귀 출발점은 `tests/game-core/pitch-trajectory.test.ts`, `pitch-calibration.test.ts`,
`batter-discipline.test.ts`, `tests/server/pitch-analysis-service.test.ts`,
`apps/server/tests/pitch-analysis-api.test.ts`, `batter-discipline.test.ts`,
`tests/persistence/postgres-revision-store.test.ts`, `tests/web/pitch-analysis-page.test.ts`,
`batter-discipline.test.ts`다. 새 동작의 테스트는 해당 계층에 둔다.

코드 구현 PR의 공통 게이트는 다음과 같다.

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm schema:game:check
pnpm build
```

패키지 export/import가 바뀌면 `pnpm test:architecture`, DB 조회·저장이 바뀌면
`pnpm test:integration`, 새 화면부터 DB까지 연결하면 `pnpm test:e2e`를 추가한다.
compiler hot path가 바뀌면 `pnpm performance`도 수행한다. 모형의 시간은 전용 실행 측정으로 기록한다.
DSN 없이 skip한 DB suite를 통합 검증 완료로 취급하지 않는다. 테스트는 격리 자원과 저장 fixture를 쓴다.

## 6. 문서·상태 관리

전체 시즌 후속 검증은 `analysis:audit`로 실행한다. A12 전체 투수의 표본·결정론 점검과
품질/구종 기대 효과/운용 HTTP의 순차·동시·취소 검증을 분리하며 기존 repository·worker·route를
재사용한다. 운영 DB 쓰기와 모델 학습은 이 검증 명령의 책임에 포함하지 않는다. 상세 범위는
[실데이터 검증 절차](real-data-validation.md)를 따른다.

A12의 조건을 맞춘 운용 비교를 구현했다. 역할·구종·타석·카운트의 공통 셀, 지표별 분모,
경기 단위 불확실성, 미상·소표본 보류는 [기능 문서](features/12-pitcher-workload.md)에 고정했다.
기존 등판 조회와 공유하는 날짜 계산/원천 조회만 추출하고 기존 worker와 지연 로드 패널에 연결했다.
실제 전체 투수의 준비 비율·결정론·비용은 [전체 시즌 검증](2026-09-21-full-audit.md)에 기록했다.

시즌별 모델 운영과 반복 조회 검증 최적화의 구현 범위는 [모델 운영 설계](model-management.md)를
따른다. 모델별 학습·검증·공개 책임은 유지하며 여섯 종류의 고정 실행 순서만 조립한다.

- 기능 문서의 체크박스는 실제 검증과 배포 가능한 코드가 함께 있을 때만 완료한다.
- 정의가 바뀌면 이 설계, 해당 기능 문서, 기존 기능 문서와 테스트를 함께 수정한다.
- 모델이 기준을 못 넘으면 기술 통계 기능까지 완료하고 모델 결과는 미채택으로 기록한다.
- 추가 자료를 쉽게 입수하지 못하면 관련 보조 기능을 제거하며 핵심 기능에 임의 추정을 넣지 않는다.
- 코드·테스트 완료와 실행 중인 컨테이너 반영을 구분한다. 이번 설계 문서 작성은 배포 작업이 아니다.

## 품질 요약 조회 후속 단계

- [x] 경기별 시즌 요약을 strict/hash/합계 검증 후 원자 저장하고 서버 재시작에 재사용한다.
- [x] 날짜 필터를 저장된 경기 요약에서 집계하고 다른 시즌의 변경은 분리한다.
- [x] current revision·분류·유효 신장·계산 정의를 확인해 영향을 받는 시즌을 무효화한다.
- [x] 미준비 GET을 202로 반환하고 제한된 준비 작업·상태 표시·실패 재시도를 연결한다.
- [x] 격리 DB와 실제 자료에서 기존 응답 일치, 기간/재시작 재사용과 갱신을 검증한다.

[설계·검증 기록](2026-09-21-coverage-preparation.md)을 따른다.
