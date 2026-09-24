# 저장·세션 책임 분리와 Graft 색인 범위

## 변경 이유

Graft로 확인한 주요 조정 모듈에 DB 행 변환, current 파일 복구, 보정 세션 수명 관리가 함께 있었다.
기존 동작을 유지하면서 변경 이유가 다른 코드를 내부 모듈로 분리했다. 새 서비스나 저장 형식은
추가하지 않았고 공개 package export와 오류 클래스의 identity를 유지했다.

## 내부 소유권

| 소유 모듈                       | 책임                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `revision-store.ts`             | import transaction, blocking 거부, projection 재검증·재컴파일, seal·current 갱신 |
| `revision-manifest.ts`          | DB 계약 확인, revision manifest 읽기·쓰기와 strict row 검증                      |
| `revision-types.ts`             | revision 입출력 타입과 공유 오류 클래스                                          |
| `projection-values.ts`          | projection scalar·enum·공통 값의 검증                                            |
| `projection-events.ts`          | typed relay header/subtype의 결합과 이벤트 strict decode                         |
| `projection-ledger.ts`          | 무결성 검증과 correction draft를 위한 V2 원장 복원                               |
| `projection-replay.ts`          | 저장 play·movement·PA·pitch·선수 fact의 재생 입력 변환                           |
| `staging-workspace.ts`          | writer lock, 경기별 작업·전환 직렬화, 원장 저장, catalog·import target 갱신      |
| `workspace-current-store.ts`    | current 경로, CAS, journal 기록·roll-forward, 이전 artifact 보존                 |
| `workspace-original-store.ts`   | 최초 원장·finding의 immutable 보관, strict 읽기와 저장 후 hash 확인              |
| `workspace-journal-store.ts`    | 교정·수집 저널 기록·strict 읽기, callback 성공 후 제거, 수집 중단 결과 복구      |
| `workspace-findings.ts`         | finding envelope 생성·strict 읽기, sidecar 부재의 빈 finding 처리                |
| `workspace-errors.ts`           | workspace 전환·복구의 공유 오류 클래스                                           |
| `correction-session-manager.ts` | command/undo/redo의 전체 컴파일, preview, history와 commit 조정                  |
| `correction-session-store.ts`   | session 등록·삭제·용량·유휴 회수, mutex 안의 version 검사                        |
| `correction-session-state.ts`   | 내부 session 타입, 오류 클래스와 응답 사본 생성                                  |

공개 재생과 원장 복원은 공통 typed event decoder를 사용하지만 서로를 호출하지 않는다.
변환 모듈은 compiler나 DB adapter를 실행하지 않는다. `import type`을 사용해 타입 참조가 런타임
모듈 초기화로 이어지지 않게 한다.

파일 current store는 workspace가 가진 lock 검증과 artifact 검증 callback을 사용한다. 원래의
검증·journal·current 교체·archive 순서를 유지하며 실패 전후 catalog 무효화는 workspace에 남긴다.
startup 복구 순서와 V1 manifest upgrade 복구도 바꾸지 않는다.

세션 생성은 비동기 읽기·컴파일 전후 용량을 확인한다. 유휴 회수는 진행 중인 mutex와 미저장 history를
보존하며, mutation version은 lock을 얻은 뒤 검사한다. compiler 또는 파일 저장 실패 뒤에는
document·version·history를 부분 갱신하지 않는다.

## Graft

`pnpm graft:build`는 `apps`, `packages`, `tests`, `scripts`와 루트 ESLint/Vitest 설정만 색인한다.
`--only-dir` 범위는 Graft fingerprint에 보존돼 CLI와 MCP의 후속 자동 갱신에도 적용된다.
새 checkout은 이 명령으로 시작하며 범위를 넓힐 때는 `package.json`의 명령을 함께 수정한다.

설치된 Graft는 Git 파일 조회가 실패하면 파일시스템 순회로 전환한다. 이 경로에는 Git ignore 규칙이
적용되지 않아 `test-results`와 `analysis`의 과거 소스 및 외부 라이브러리가 포함될 수 있었다.
명시적 허용 범위로 이 경로에서도 현재 애플리케이션의 심볼을 유지한다. 원본 산출물은 삭제하지 않는다.

## 검증 범위

- 아키텍처 테스트는 TypeScript를 변환한 뒤 runtime import의 전이적 의존성을 검사한다.
  재생에서 원장 hydration·compiler로 진입하거나, 내부 store가 상위 조정 모듈로 역참조하면 실패한다.
- 보정 session 회귀는 비식별 fixture로 진행 중인 preview의 유휴 회수 방지와 종료 후 회수를 검사한다.
- 기존 workspace 테스트로 writer lock, hash 검증, source 보존, current 전환 실패, journal 복구를 확인한다.
- PostgreSQL 통합 테스트로 typed 원장 왕복, revision append, rollback, sealed 보호와 replay hash를 확인한다.
- 전체 품질 게이트와 격리 Compose E2E로 서버·웹 조립 및 backup/restore 경로를 확인한다.

## 검증 결과

2026-09-23 현재 작업 트리에서 Node 24.21.0과 Corepack의 pnpm 10.15.1로 검증했다.

| 검사                               | 결과                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| lint·format·typecheck·schema·build | 통과                                                            |
| 전체 Vitest                        | 188개 파일, 1,069개 통과; DB 76개는 별도 통합 검사로 실행       |
| 격리 PostgreSQL 통합               | 76개 통과                                                       |
| 격리 Compose E2E                   | 보정·적재·재생·분석 UI·재시작·백업/복구 통과, 브라우저 오류 0개 |
| compiler 성능                      | 558개 이벤트, 200회: 평균 4.352ms, p95 5.547ms                  |
| replay 성능                        | 21개 이벤트, 500회: 평균 0.743ms, p95 1.091ms                   |
| Graft CLI·MCP                      | 674개 파일, 제외 경로 0개, 주요 세 클래스의 정의 각각 1개       |
| Graft freshness                    | 통과                                                            |

`revision-store.ts`에서 분리한 함수와 남긴 메서드 78개의 본문을 TypeScript AST로 비교해 변경이
없음을 확인했다. 해당 파일은 1,837행에서 492행으로, `staging-workspace.ts`는 1,493행에서
1,172행으로, correction session manager는 487행에서 373행으로 줄었다. 행 수는 분리 범위의
참고값이며 책임 경계와 기존 무결성 검증이 기준이다.

Graft Git 하위 프로세스가 제한된 환경에서 `EPERM`으로 실패하는 것을 재현했고, 명시적 범위가
파일시스템 fallback에도 유지됨을 확인했다. 기존 2,496개 파일 색인에서 과거 복사본·연구 산출물을
제외했으며, 새 모듈과 테스트를 포함한 최종 색인은 674개다.

검증 로그는 `test-results/structure-refactor-20260923/`에 보존한다. 통합/E2E가 만든 임시 자원은
정리했으며 운영 workspace와 PostgreSQL 데이터는 변경하지 않았다.

## 후속 구조 정리

AGENTS의 파일 배치를 실제 current/active/superseded 구조와 맞추고 API의 staging 명칭이 ready
상태를 뜻함을 명시했다. compiler 진입점 이름도 `compileStagingGameDocumentV2`로 맞췄다.

DB correction draft route는 workspace의 `saveCorrectionDraft`만 호출한다. workspace가 strict decode와
한 번의 전체 compile을 마친 뒤 compiler findings와 ready/quarantine을 함께 저장한다. 서버는
기존 공용 `ComputationPool`을 workspace에 주입하며 수집 저장과 기록정정 초안의 compiler도 같은
worker를 사용한다. CLI와 단위 테스트의 기본 compiler는 유지한다. 주입된 계산이 실패하면
original/current를 쓰지 않으며, worker warmup 또는 workspace open 실패 시 pool을 닫는다.

| 모듈                                                     | 책임                                         |
| -------------------------------------------------------- | -------------------------------------------- |
| `record-correction-repository.ts`                        | 공개 API와 내부 저장소 조립                  |
| `record-correction-jobs.ts`                              | 수집 작업 수명·복구·조회                     |
| `record-correction-sources.ts`                           | strict 시즌 원문 적재·봉인·공지 복원         |
| `record-correction-cases.ts`                             | 경기 후보·평가·검토 상태와 목록 조회         |
| `record-correction-db.ts` / `record-correction-types.ts` | 공통 DB 계약 검사·시간 변환·공유 타입과 오류 |
| `correction-drawer.tsx`                                  | 입력 상태·명령 제출·폐기 확인·포커스         |
| `correction-drawer-parts.tsx`                            | 제목과 추가 행 목록                          |
| `event-fields.tsx`                                       | 이벤트 종류별 입력 컴포넌트 선택             |
| `event-fields-batting/runner/substitution/notice.tsx`    | 타석·투구, 주자 이동, 교체, 판독·안내 입력   |
| `event-field-context.tsx`                                | 공통 props·기존 컨텍스트 표시 보조           |

기록정정 repository는 1,358행에서 178행으로, drawer는 1,343행에서 592행으로 줄었다.
SQL 트랜잭션 순서, 공개 메서드 시그니처, 오류 identity와 기존 입력 모델을 유지했다. 이동한
메서드·함수·JSX 분기 54곳을 AST와 JSX 변환 결과로 비교했으며 동작 본문 차이는 없었다.

실제 worker를 사용하는 HTTP 회귀는 정상 fixture와 비식별 기록 불일치 fixture로 한 번의 compile,
ready/quarantine 선택과 계산 실패 후 기존 파일 보존을 검증한다. 구조 테스트는 하위 기록정정
저장소의 repository 역참조, 입력 UI의 drawer 역참조, replay route의 compiler 로딩을 차단한다.
후속 검증 로그는 `test-results/remaining-structure-20260923/`에 보존한다.

후속 변경과 기존 미커밋 변경을 함께 검증한 결과는 다음과 같다.

| 검사                               | 결과                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| lint·format·typecheck·schema·build | 통과                                                                         |
| 관련 회귀                          | 87개 통과                                                                    |
| 전체 Vitest                        | 188개 파일, 1,075개 통과; DB 76개는 별도 실행                                |
| 격리 PostgreSQL 통합               | 76개 통과                                                                    |
| 격리 Compose E2E                   | 보정·적재·재생·분석 UI·재시작·백업/복구·여섯 모델 worker 통과                |
| compiler 성능                      | 평균 5.021ms, p95 6.933ms                                                    |
| replay 성능                        | 평균 0.827ms, p95 1.238ms                                                    |
| Graft                              | 686개 파일, 3,464개 심볼, 11,841개 연결; 제외 경로 유입 없음, freshness 통과 |

통합 테스트와 E2E의 임시 컨테이너·네트워크·볼륨은 종료 후 제거했다. 운영 데이터는 변경하지 않았다.

## 타석 매칭 worker와 후속 책임 분리

기록정정 서비스의 `assessNotice`가 직접 실행하던 전체 컴파일과 타석 후보 계산을
`record_correction_match` 메시지로 공용 worker에 넘긴다. `record-correction-matching.ts`는 기존
타자·투수·타순 판정과 후보 ID 생성을 그대로 소유하며 서비스는 DB 읽기와 평가 저장을 조정한다.
한 평가에서 읽은 원장은 제안에 재사용하고 제안 계산 후 DB current revision·document hash를
다시 확인한다. 변경되거나 사라진 base와 worker 실패는 평가 저장으로 이어지지 않는다.

`source-bundle-store.ts`는 canonical 원문·압축 파일·manifest의 immutable 저장을 맡는다.
writer lock 확인은 workspace에 남는다. `workspace-integrity.ts`는 시작 시 legacy 파일 거부,
current manifest 검증, orphan artifact 검사를 맡고 검증한 항목만 callback으로 전달한다.
workspace는 catalog와 import target을 반영하며 journal 복구와 검증 순서는 유지한다.

보정 화면은 저장 제어, finding 목록, 가상 타임라인, 이벤트 상세, 공식 기록 비교, 원본 비교로
분리했다. 목록과 이벤트 상세는 finding 상세 컴포넌트를 공유한다. 기존 패널 모듈은 명시적 export로
연결하며 canonical 배열 기준 이동, 키보드 메뉴, finding 탐색과 원천 증거 표시를 유지한다.

분리한 UI·매칭 함수와 유지한 workspace 메서드 등 72개의 본문을 비교했다. 기존 JSX는 변환 후
비교했으며 receiver 변경과 공백만 정규화했다. 회귀 테스트는 실제 worker 결과, 평가당 원장 1회
읽기, worker 실패, 계산 중 DB revision·hash 변경 및 삭제를 검증한다. 아키텍처 검사는 새 모듈의
상위 계층 역참조와 서비스의 직접 compiler import를 차단한다.

검증 로그는 `test-results/additional-improvements-20260923/`에 보존한다.

| 검사                               | 결과                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| lint·format·typecheck·schema·build | 통과                                                                                      |
| 관련 회귀                          | 101개 통과                                                                                |
| 전체 Vitest                        | 188개 파일, 1,091개 통과; DB 76개는 별도 실행                                             |
| 격리 PostgreSQL 통합               | 76개 통과                                                                                 |
| 격리 Compose E2E                   | 보정·기록정정·적재·재생·분석 UI·재시작·백업/복구·여섯 모델 worker 통과, 브라우저 오류 0개 |
| compiler 성능                      | 558개 이벤트, 200회: 평균 5.483ms, p95 8.033ms                                            |
| replay 성능                        | 21개 이벤트, 500회: 평균 0.855ms, p95 1.441ms                                             |
| Graft                              | 696개 파일, 3,469개 심볼, 11,874개 연결; 제외 경로 0개, freshness 통과                    |

운영 workspace와 DB는 변경하지 않았으며 검증용 임시 자원은 종료 후 정리했다.

## 원본 보관과 저널 분리 — 2026-09-24

`StagingWorkspace`에 남아 있던 최초 원본·finding의 경로와 파일 처리, 교정·수집 저널의
기록·읽기·제거를 두 내부 store로 옮겼다. 두 store는 공개 package API로 노출하지 않으며
workspace나 current store를 역참조하지 않는다. finding envelope helper와 선택적 파일 삭제는
하위 공통 모듈에서 공유한다. 기존 미커밋 개선을 보존하고 기록정정 중복 컴파일은 변경하지 않았다.

workspace는 open 상태·writer lock, 교정 base hash·superseded current 확인, 최초 원본 보존,
저장 분류·전체 컴파일·current 전환과 catalog 무효화를 조정한다. journal store의 callback은
`saveReady`/`saveQuarantine`으로 돌아오며 검증을 생략하지 않는다. 원본 finding을 먼저 저장하고
문서를 저장·재조회하는 순서, 성공 전 journal을 남기는 동작, startup 복구 순서를 유지했다.

회귀 테스트는 journal 기록 직후와 current 교체 직후의 실패, 재시작을 반복해도 유지되는 current,
최초 finding 보존, 잘못된 원본·strict journal·차단 문서 승격의 거부, 복구 실패 시 잠금 해제,
잠금 상실·닫힌 workspace의 쓰기 거부, 수집 결과의 역순 정렬과 대상 journal만 제거하는 동작을
검증한다. 기존 비식별 경기 fixture와 임시 workspace만 사용한다.

이번 검증 로그는 `test-results/workspace-store-refactor-20260924/`에 보존한다.

| 검사                               | 결과                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| 구조 비교                          | 공개 메서드 signature 유지, 조정자 메서드 34개와 이동한 본문 14개 일치               |
| 관련 회귀                          | 49개 통과                                                                            |
| lint·format·typecheck·schema·build | 통과                                                                                 |
| 전체 Vitest                        | 189개 파일, 1,103개 통과; DB 76개는 별도 실행                                        |
| 아키텍처                           | 37개 통과                                                                            |
| 격리 PostgreSQL 통합               | 76개 통과                                                                            |
| 격리 Compose E2E                   | 교정·기록정정·적재·재생·분석 UI·재시작·백업/복구·모델 worker 통과, 브라우저 오류 0개 |
| Graft 재색인                       | 700개 파일, 4,182개 노드, 11,930개 연결                                              |

운영 데이터는 사용하지 않았으며 테스트가 만든 컨테이너·네트워크·볼륨과 임시 workspace는 정리했다.
