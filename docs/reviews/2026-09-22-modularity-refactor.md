# 모듈 경계와 반복 비용 점검

## 범위와 판단 기준

2026-09-22 기준 전체 저장소의 패키지 의존성, 공개 API, 주요 호출 경로와 관련 회귀 테스트를
점검했다. contracts, collection, correction, game-core, persistence, replay, test-fixtures,
server, web의 책임을 확인하고 정적 런타임 import 그래프의 순환도 검사했다.

추출 단위는 파일 길이가 아니라 같은 변경 이유와 불변식을 공유하는 코드다. 새 서비스, 범용
repository, 작업 프레임워크, 화면 설정 언어는 추가하지 않았다. 분석 조회와 봉인 쓰기처럼
권위·실패 복구가 다른 경로는 분리 상태를 유지한다.

## 변경한 책임 경계

| 영역             | 발견한 문제                                                                  | 변경                                                                                  |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| contracts        | sparse 배열이 직렬화 검증을 건너뛰고 배열 symbol key도 누락                  | 정상 dense 배열의 출력은 유지하며 빈 슬롯·symbol key를 명시적으로 거부                |
| collection       | 응답 전체를 메모리에 읽은 뒤 크기 제한 검사                                  | 공용 HTTP reader에서 실제 바이트를 누적해 제한 초과 즉시 취소                         |
| correction       | command 조립과 tracking 연결·PA 문맥 추종이 한 모듈에 결합                   | tracking 규칙을 내부 모듈로 이동하고 전체 컴파일·preview 책임은 command 진입점에 유지 |
| game-core        | 구질 모델의 fitting·검증·시즌 선택·조회가 결합되고 매치업도 학습 파일에 의존 | target/prediction, fitting, evaluation, training, response로 역할 분리                |
| persistence      | 17개 분석 모듈의 20개 snapshot 경로가 종료·실패 정리를 반복                  | 읽기 전용 snapshot 수명만 공유하고 SQL·grain·hash는 각 repository가 소유              |
| persistence 모델 | 매치업 검증이 구질 workspace에 의존                                          | manifest·의미 검증·파일 공개를 분리하고 기존 공개 API 유지                            |
| server           | 호출 어댑터를 읽어도 무거운 실행기와 캐시가 초기화                           | protocol·caller adapter·executor 분리, inline 실행기는 실제 호출 시 로드              |
| server 전송      | 계산 풀과 선구안 worker의 대량 행 전송 반복                                  | 5,000행 상한·순서·완료·취소·이벤트 루프 양보를 하나의 전송 함수에서 유지              |
| web 조회         | 같은 선수 목록 endpoint가 페이지별 query key로 중복 조회                     | 투수/타자·시즌·기간·경기 종류가 같은 목록의 요청과 캐시 공유                          |
| web 상태         | 새 분석 화면의 URL scope 및 시즌 변경 규칙 반복                              | 순수 URL 변환과 작은 scope hook으로 분리; 기존 구질/선구안 기본값 유지                |
| web 차트         | 선택·호버마다 모든 투구와 기준 도형 다시 그리기                              | 정적 도형은 화면 크기의 canvas에 보관하고 작은 선택 표시만 합성                       |

구질과 매치업의 조회는 실제 사용할 feature kind별로 한 번만 행렬을 생성한다. 미채택 대상과
기준선만 있으면 행렬을 생성하지 않는다. 학습 후보·시간 분할·조건부 분모·채택 기준과 수치 연산
순서는 그대로다. 조회에 학습이 유입되는 새 경로는 없다.

모델 저장에서는 canonical 내용을 한 번 만들어 hash와 파일 쓰기에 함께 사용한다. atomic play
조회는 반복문 밖에서 strict schema를 한 번 구성한다. 검증의 횟수나 범위를 줄인 것이 아니다.

화면 검증에서는 두 분석 페이지의 동시 선수 목록 요청이 한 번으로 합쳐지는 것을 확인했다.
1만 개 점 차트의 선택·호버는 점을 다시 그리지 않으며, 한 개의 배경 bitmap을 scene 변경과
unmount 때 해제한다. 확대·회전·데이터 변경은 전체 도형을 다시 그려야 한다. 포인터 hit testing의
O(N) 순회는 유지하며, 이번 변경으로 그 연산까지 상수 시간이 된다고 해석하지 않는다.

## 자원과 오류 처리

`withAnalysisSnapshot`은 동일한 연결에서 READ ONLY REPEATABLE READ, 30초 statement timeout,
COMMIT/ROLLBACK과 반환을 책임진다. 계산 전에 필요한 입력을 모두 읽은 경로는 명시적으로
연결을 일찍 반환한다. 종료 요청이 겹쳐도 한 번만 COMMIT/반환하고, rollback 실패 시 연결을
폐기하면서 최초 오류를 유지한다. 반환 뒤 같은 client를 조회에 재사용하지 않는다.

봉인 revision 저장, writer lock, current pointer, staging journal, 기록정정 쓰기 transaction은
이 조회 helper에 넣지 않는다. 기존 원자성·복구 경계의 책임을 유지한다.

스트리밍 HTTP reader는 선언된 Content-Length와 실제 읽은 바이트를 각각 확인한다. 크기 초과나
읽기 실패 시 body를 취소하고 lock을 해제한다. UTF-8 다중 바이트 경계·BOM 처리와 기존 취소/오류
분류를 보존한다. 실제 Naver 호출을 테스트에 사용하지 않는다.

## 유지한 구조

- collection의 원천 해독 → 근거 판단 → 이벤트 방출 → strict mapping 경계, 제공자 어휘의 소유권.
- compiler의 atomic play, candidate commit, 관찰값 비교, blocking 정책과 단일 계산 권위.
- 기능별 strict TypeBox 계약과 명시적 public barrel. DB migration과 API/모델 형식 변경 없음.
- replay의 typed fact → atomic frame 변환. compiler/persistence 런타임 의존성 추가 없음.
- 재사용 계산 풀, 한 번 실행하는 학습 worker, 상태를 보유하는 선구안 worker의 별도 수명주기.

## 검증

구질·매치업 학습 모델, 조회 응답, 미채택 응답의 canonical 전체 내용을 변경 전후 대조해
동일함을 확인했다. 비교 입력은 비식별 deterministic fixture이며 원천 DB를 사용하지 않았다.
기존 교정·야구 규칙·projection/replay hash 회귀를 유지한다.

추가 회귀는 snapshot 수명/실패/중복 종료, 내용 hash는 맞지만 의미가 잘못된 모델,
worker 실행기 import 격리와 행 전송, 조건부 예측·행렬 공유, 선수 목록 요청 병합/취소/범위 격리,
URL 이력·기본값, sparse/symbol 배열, 응답 스트림 상한·취소·UTF-8 경계를 다룬다.

최종 검증 결과는 다음과 같다.

| 검사                                          | 결과                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| 전체 lint·format·typecheck·schema check·build | 모두 통과                                                                           |
| 전체 테스트(architecture 포함)                | 176개 파일, 939개 테스트 통과; DB 75개는 별도 통합 검사로 실행                      |
| 격리 PostgreSQL 통합 검사                     | 75개 테스트 통과                                                                    |
| 분석 검증·감사 스크립트 검사                  | 7개 테스트 통과                                                                     |
| 격리 Compose E2E                              | 수집·교정·기록정정·import·replay·분석 화면·백업/복구·재시작 통과, 브라우저 오류 0개 |
| 모델 운영 경로                                | 6종 모델 worker, 공개, 멱등성, 재시작 후 모델·기준값 캐시 재사용 통과               |
| compiler 성능                                 | 558개 이벤트 fixture, 200회: 평균 4.035ms, p95 4.799ms                              |
| replay 성능                                   | 21개 이벤트/16개 play fixture, 500회: 평균 0.624ms, p95 0.720ms                     |

compiler와 replay 모두 평균 10ms·p95 25ms 기준을 만족한다. 호스트 측정은 Node 24.19.0이며,
E2E 컨테이너는 Node 24.18.0을 사용했다. E2E의 작은 분석 fixture를 30회씩 조회한 결과,
warm 평균은 타격 3.80ms, 투구 3.61ms, 구질 입력 3.12ms, 구장 환경 2.59ms, 투구 순서 4.66ms였다.
이는 해당 fixture의 repository·worker 측정이며 HTTP·브라우저 렌더링을 포함하지 않는다.
운영 전체 데이터의 응답 시간이나 변경 전후 속도 향상률을 뜻하지 않는다.

모델·응답 canonical 비교의 변경 전후 SHA-256은 모두
`223c77d4667347fc828bb5166c4dc7aaef35a428b2db0152d6c76ffa7d24f64f`였다.
PostgreSQL과 Compose 검사는 고유 이름의 임시 자원에서 실행하고 생성한 자원을 정리했다.
운영 배포나 사용자 데이터 변경은 수행하지 않았다.

검증 로그는 `analysis/commit-preparation/20260922-refactor/`에 로컬 보존하며 Git에는 넣지 않는다.

## Context7으로 확인한 라이브러리 계약

- PostgreSQL transaction은 하나의 checked-out client를 사용하고 종료 시 반환해야 한다.
  [node-postgres transaction 문서](https://github.com/brianc/node-postgres/blob/master/docs/pages/features/transactions.mdx)
- Fastify의 자원 소유자는 plugin 등록 범위와 종료 hook 순서에 맞춰야 한다.
  [encapsulation](https://github.com/fastify/fastify/blob/main/docs/Reference/Encapsulation.md),
  [lifecycle hooks](https://github.com/fastify/fastify/blob/main/docs/Reference/Hooks.md)
- React hook은 상태를 공유하는 것이 아니라 상태 처리 로직을 재사용한다. 요청 공유는 query cache의
  동일한 의미를 가진 key로 처리한다.
  [custom hook 문서](https://github.com/reactjs/react.dev/blob/main/src/content/learn/reusing-logic-with-custom-hooks.md)
