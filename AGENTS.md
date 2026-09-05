# KBO Workbench 에이전트 가이드

## 적용 범위

이 파일은 저장소 전체에 적용된다. 하위 디렉터리에 더 구체적인 `AGENTS.md`가 생기면 그 파일은 해당 하위 트리에서 이 규칙을 보완하거나 좁힐 수 있다.

이 저장소는 단순한 경기 JSON 편집기가 아니다. 외부 제공자의 불완전한 경기 기록을 원본 증거로 보존하고, 사람이 교정할 수 있는 평탄한 원장으로 정규화한 뒤, 단 하나의 결정론적 컴파일러로 야구 상태와 통계를 계산하여, 검증된 사실만 PostgreSQL에 봉인하고 재생하는 로컬 웹 워크벤치다.

변경 전에는 최소한 다음 문서를 함께 읽는다.

- `README.md`
- `kbo_workbench_web_implementation_spec.md`
- 변경 영역과 관련된 `docs/*.md`
- 관련 패키지의 공개 진입점인 `src/index.ts`
- 변경 동작을 고정하는 기존 테스트

문서와 코드가 어긋나면 임의로 둘 중 하나를 정답으로 간주하지 않는다. 현재 테스트와 런타임 경로를 확인하고, 의도된 계약을 명확히 한 다음 코드·테스트·문서를 함께 맞춘다.

## 시스템 모델과 권위 경계

전체 데이터 흐름은 다음과 같다.

```text
Naver 응답
  -> collection 정규화
  -> StagingGameDocumentV2 평탄 원장
  -> game-core 전체 컴파일 및 검증
  -> .data/staging 또는 .data/quarantine
  -> persistence 트랜잭션 투영 및 봉인
  -> PostgreSQL typed facts
  -> replay API
  -> web 로컬 재생
```

각 계층의 권위는 분리되어 있다.

| 계층                                 | 권위와 책임                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| 외부 응답과 원문                     | 관찰된 증거. 신뢰할 수 없는 값도 출처와 함께 보존한다.                            |
| `StagingGameDocumentV2`              | 사람이 교정할 수 있는 소스 원장. 최종 경기 상태나 공식 통계 자체가 아니다.        |
| `game-core` 컴파일러                 | 볼·스트라이크·아웃·주자·점수·타석·통계에 대한 유일한 계산 권위다.                 |
| `.data/staging` / `.data/quarantine` | 현재 교정 문서의 파일 권위다. 하나의 경기는 둘 중 정확히 한 위치에만 존재한다.    |
| PostgreSQL sealed revision           | 가져오기가 끝난 불변의 분석·재생 권위다.                                          |
| 웹 클라이언트                        | 서버 상태의 표현과 명령 전송을 담당한다. 경기 규칙이나 영속 상태의 권위가 아니다. |

이 경계를 흐리는 캐시, 병렬 계산기, 브라우저 전용 규칙, 데이터베이스 직접 교정 경로를 만들지 않는다.

## 핵심 설계 원칙

### 1. 소스를 버리거나 지어내지 않는다

- 의미 있는 제공자 중계 행은 반드시 원장의 이벤트 하나가 된다. 완전히 해석된 이벤트, 검토/관리 이벤트, 또는 `unresolved` 중 하나여야 한다.
- 알 수 없는 행을 조용히 삭제하지 않는다. `sourceEventId`, 원문 위치, 원문 텍스트와 가능한 관찰값을 보존하고 이후 행 처리를 계속한다.
- 제공되지 않은 타자 시작, 이닝 종료, 투구, 타석 결과, 주자 이동을 합성하지 않는다.
- `observedStateAfter`는 비교용 증거일 뿐이다. 계산된 상태나 컨텍스트를 덮어쓰는 입력으로 사용하지 않는다.
- 제공자 별칭, 한국어 중계 어휘와 정규식은 `collection`에만 둔다. `game-core`에 Naver 명칭이나 한국어 문장 패턴을 넣지 않는다.
- 동일 강도의 증거가 충돌하면 추측하지 말고 `unresolved`와 구체적인 finding을 만든다. 명시된 선수 ID가 로스터나 팀과 모순되어도 임의 보정하지 않는다.
- finding에는 가능하면 endpoint, block, row, `sourceEventId`, 원문 텍스트 등 정확한 출처를 남긴다.

### 2. 원장은 평탄하고 최소한이어야 한다

허용되는 원장 이벤트의 의미 단위는 `half_inning_start`, `batter_start`, `pitch`, `plate_result`, `runner_advance`, `substitution`, `review`, `administrative`, `unresolved`다.

- 이벤트 `sequence`는 항상 배열 인덱스와 일치해야 한다.
- 외부 행의 이벤트 ID와 소스 위치는 결정론적이고 안정적이어야 한다.
- 수동 추가 이벤트는 UUIDv7 ID와 수동 `relayText`를 가져야 한다.
- 이벤트 교체는 기존 identity, 소스 위치, sequence를 보존한다.
- 원장에 볼카운트, 아웃, 베이스 상태, 점수, 타석 집계, 선수 통계, DB play를 중복 저장하지 않는다.
- `plate_result`는 타석 결과와 타자에게 직접 귀속되는 정보만 가진다. 기존 주자의 이동은 항상 별도 `runner_advance` 이벤트다.
- 타자의 기본 이동만 결과에서 유도할 수 있다. 기존 주자의 이동은 결과나 관찰 상태에서 추론하지 않는다.
- 타석 결과에 연결된 주자 이동은 `plateResultEventId`를 사용한다. 독립 주자 이동은 명시적인 reason을 가져야 한다.
- `sourcePitchId`는 선택 사항이고 유일하지 않다. 이벤트 identity나 일반 dedupe key로 사용하지 않는다.
- ID가 없는 투구는 중복 제거 후보가 아니다. `trackingId`가 다른 tracking 관찰값은 모두 보존한다.
- 같은 `sourcePitchId`로 연결 후보가 여럿이면 임의로 하나를 선택하지 않고 연결하지 않은 채 남긴다.
- 중복 제거는 의미적으로 정확히 같은 재전송에만 적용한다. 수정 중계 suffix는 block revision 규칙을 따른다.

### 3. 컴파일러만 파생 상태를 계산한다

`compileStagingGameDocument`는 외부 문서를 먼저 strict decode한 뒤 전체 경기를 계산하는 유일한 진입점이다. 다음 시점마다 전체 컴파일을 수행한다.

- collection mapping이 끝난 뒤
- 모든 correction command 또는 atomic batch 뒤
- PostgreSQL import 직전
- DB 투영 무결성을 확인하기 위해 내부 원장을 재구성한 뒤

컴파일러 변경 시 다음 불변식을 보존한다.

- 이벤트별로 상태와 컨텍스트를 복제해 candidate에 적용하고, 새 blocking finding이 없을 때만 commit한다.
- 한 타석 결과, 연결된 주자 이동, 그 play에 붙은 review/administrative 행은 하나의 atomic play다. 일부만 상태에 반영하면 안 된다.
- 상태 경계 사이의 연속된 독립 주자 이동은 reason이 달라도 하나의 live-ball play다.
- 연결된 주자 이동 사이에는 상태를 바꾸지 않는 review/administrative만 올 수 있다. dangling, 조기, 끊긴 연결은 blocking이다.
- movement engine은 복제된 상태를 검증한 뒤 한 번에 반영한다. 일부 이동만 성공시키지 않는다.
- `source_half_incomplete` 경계는 blocking finding을 유지하면서도 다음 half를 독립 계산할 수 있게 하는 명시적 예외다.
- 자동 볼/스트라이크와 `no_pitch`는 실제 투구 수에 포함하지 않는다.
- 2스트라이크 일반 파울, 번트 파울, foul tip은 서로 다른 규칙으로 처리한다.
- 결과 없이 terminal count에 도달하면 blocking이다.
- `third_out`, `walk_off`, `called_game`, `forfeit`, `source_boundary`, `end_of_document`로 끝난 partial PA는 실제 투구를 유지하지만 공식 PA/AB/BF에는 포함하지 않는다.
- 3아웃 뒤 다음 half는 독립적으로 시작한다. 3아웃 미만인 소스 경계는 incomplete finding을 남긴다.
- 투수 책임 주자는 볼넷 중 투수 교체, 2스트라이크 대타 삼진, 대주자, 야수선택 책임 slot까지 보존한다.
- apparent fourth out과 force/time/appeal run scoring 규칙을 단순 아웃 순서로 대체하지 않는다.
- 공식 집계 비교는 제공된 필드만 비교한다. 빠진 선택 필드를 0으로 만들지 않는다.
- 득점 play에 명시적 RBI가 없으면 공식 RBI 비교는 경고 또는 검증 불가로 남긴다. 자책점은 계산하지 않는다.
- finding은 event sequence와 code 기준으로 결정론적으로 정렬하고, source/domain/persistence 범주와 warning/blocking 심각도를 유지한다.
- `unresolved` 이벤트는 blocking이다.
- 제공자 관찰 상태는 신뢰 가능한 sync point에서만 비교한다. 투구는 투구 단위, atomic play는 마지막 행에서 비교하며 동일 mismatch를 중복 보고하지 않는다.

결정론은 기능 요구사항이다. 동일한 정규화 문서는 시간, 플랫폼, 실행 순서와 무관하게 동일한 findings, projection, hash와 replay frame을 만들어야 한다.

## 계약과 정규화

`packages/contracts`가 런타임 계약의 소유자다.

- TypeBox 스키마를 사용하며 객체는 원칙적으로 `additionalProperties: false`인 strict 계약이다.
- 네트워크, 파일, DB hydration 등 외부 경계에서는 TypeScript 타입 단언이 아니라 런타임 decode를 수행한다.
- Fastify route는 params, body, response schema를 선언한다.
- 웹은 API 응답을 TypeBox `Value`로 검증하고 사용한다.
- 계약을 느슨하게 만들어 오래된 데이터나 잘못된 응답을 조용히 통과시키지 않는다.

Canonical JSON은 해시, fingerprint, idempotency의 기반이다.

- 객체 key를 정렬하고 문자열과 key를 NFC 정규화한다.
- `-0`을 정규화한다.
- `undefined`, symbol, 순환 참조, non-plain object, non-finite number, unsafe integer를 거부한다.
- 정렬되지 않은 객체 열거 순서나 로컬 시간에 의존하는 직렬화를 해시 입력으로 사용하지 않는다.

`StagingGameDocumentV2` 계약을 바꿀 때는 다음을 한 변경으로 취급한다.

1. `packages/contracts`의 TypeBox 소스와 필요한 명시적 barrel export를 수정한다.
2. collection, compiler, correction, persistence, web의 소비자를 함께 점검한다.
3. 서버 또는 contracts build 후 `pnpm schema:game:write`로 `schemas/staging-game-document-v1.schema.json`을 재생성한다.
4. `pnpm schema:game:check`와 contract/golden 테스트를 실행한다.

명시적인 버전/제품 결정 없이 호환성 분기, revision 2, 암묵적 backfill을 추가하지 않는다.

## 패키지와 의존성 경계

저장소는 pnpm workspace 기반의 ESM 모듈러 모놀리스다. 독립적인 확장, 장애 격리, 배포 주기가 입증되지 않았다면 새 서비스나 배포 단위를 만들지 않는다.

허용되는 핵심 의존성 방향은 다음과 같다.

| 패키지          | 내부 의존 가능 대상                   |
| --------------- | ------------------------------------- |
| `contracts`     | 없음                                  |
| `game-core`     | `contracts`                           |
| `collection`    | `contracts`, `game-core`              |
| `correction`    | `contracts`, `game-core`              |
| `persistence`   | `contracts`, `game-core`              |
| `replay`        | `contracts`, `game-core`              |
| `test-fixtures` | 없음                                  |
| `apps/server`   | 위 패키지를 조립하는 composition root |
| `apps/web`      | `contracts`, `game-core`의 공개 API   |

추가 규칙은 다음과 같다.

- 패키지 간 import는 `@kbo/<package>` 공개 루트만 사용한다. 다른 패키지의 내부 경로를 deep import하지 않는다.
- `src/index.ts`는 명시적인 named export만 사용한다. `export *`를 사용하지 않는다.
- NodeNext 패키지의 상대 import에는 출력 기준 `.js` 확장자를 사용한다. Vite 웹 코드는 기존 bundler 관례를 따른다.
- `game-core`에 React, Fastify, `pg`, Playwright, Node filesystem/HTTP adapter를 넣지 않는다.
- `collection`은 persistence, `pg`, React에 의존하지 않는다.
- `correction`은 collection, persistence, `pg`, Playwright, React에 의존하지 않는다.
- `replay`는 persistence, `pg`, Playwright, React에 의존하지 않는다.
- production collection 코드가 특정 game ID나 fixture 경로로 분기하게 만들지 않는다.
- 의존성 변경 후 반드시 `pnpm test:architecture`를 실행한다.

## 영역별 변경 규칙

### Collection

- endpoint 응답을 직접 경기 상태로 바꾸지 말고 source value, decision, normalization context를 거쳐 평탄 원장을 만든다.
- 후보 값에는 근거, 강도, specificity, rule ID가 있어야 한다.
- 동일한 입력에 대한 이벤트 ID, 순서, 판단 결과가 항상 같아야 한다.
- abort signal과 bounded concurrency를 끝까지 전달한다.
- 실제 Naver 호출을 구현 검증이나 테스트의 기본 경로로 사용하지 않는다. 저장된 sanitized fixture를 사용한다.

### Correction

- correction은 staging/quarantine 문서만 수정한다. PostgreSQL sealed revision을 직접 수정하지 않는다.
- 자유 형식 JSON 편집기를 만들지 않는다. 모든 변경은 검증 가능한 structured command여야 한다.
- command와 batch는 원자적이다. 적용 후 resequence하고 전체 strict compile한다.
- 중간 교정을 위해 blocking draft는 허용할 수 있지만, blocking 문서는 staging으로 승격하거나 DB로 import할 수 없다. 명시적으로 quarantine에만 commit한다.
- 모든 mutation은 session version을 요구한다. stale version은 `409`로 거부한다.
- commit 시 base document hash도 확인한다.
- 브라우저가 낙관적으로 원장을 수정하지 않는다. 서버 응답을 받은 뒤 상태를 갱신한다.
- undo/redo는 command 또는 batch 단위다. 새 command는 redo를 비우며 commit/reopen은 메모리 내 history를 비운다.
- 영구 command audit나 before/after snapshot 역사를 새로 만들지 않는다.
- original 파일은 최초 한 번만 저장하고 덮어쓰지 않는다.
- pitch 삭제 시 tracking row를 보존하고 연결만 명시적으로 해제한다. ID가 없는 투구 연결을 추측하지 않는다.
- `unresolved`를 typed event로 바꿀 때 identity, source 위치, 원문을 보존한다.
- 저장된 source finding 중 재현할 수 없는 항목은 현재 compiler finding과 병합하되, 재계산 가능한 compiler finding set은 매 command마다 교체한다.

### Persistence와 Replay

- PostgreSQL 스키마는 typed relational fact를 사용한다. JSON/JSONB/ARRAY 컬럼을 도입하지 않는다.
- 현재 계약은 analytics contract 4, projection version 4이며 V3 sealed revision의 읽기·해시 규칙을 보존한다. 신규 경기는 revision 1이고 이후 교정·기록정정은 append-only revision을 추가한다. 이를 바꾸려면 migration과 명시적인 계약 결정을 먼저 한다.
- projection column descriptor가 write, read, hash 순서의 공통 권위다. 컬럼 변경은 migration, descriptor, projection, hydration, 내부 recompile, 테스트와 문서를 함께 수정한다.
- import는 하나의 트랜잭션에서 strict decode, compile, blocking 거부, document/projection hash, DB contract 확인, manifest/fact 저장, 재조회 projection hash, 내부 typed ledger 재구성과 recompile, seal, current pointer 갱신을 끝낸다.
- 어느 단계든 실패하면 전체 import를 rollback한다.
- sealed revision과 fact는 불변이며 DB trigger 보호를 우회하지 않는다.
- 공개 replay는 typed play/movement/PA/tracking fact에서 직접 만든다. staging JSON을 복원하거나 브라우저용 컴파일러를 다시 실행하지 않는다.
- staging ledger hydration은 import 무결성 검사용 내부 경로에만 둔다.
- replay frame은 atomic play 단위다.
- cursor는 game, revision, document hash, frame hash와 결합하며 page limit 상한 1000을 유지한다.
- 웹은 모든 page의 manifest, count, order, hash를 검증한 뒤 로컬 index만 이동해 재생한다.

### Server와 Web

- `apps/server`는 composition root다. 공통 hook과 오류 변환 외에 route 구현을 한 파일로 합치지 말고 system, catalog, collection, correction, import, replay 경계를 유지한다.
- 도메인 오류는 안정적인 HTTP category/status로 변환한다.
- host와 origin은 localhost 기반 경계를 유지한다. API와 DB를 불필요하게 외부에 노출하지 않는다.
- 오래 걸리는 collection/import는 server-side job으로 수행한다. idempotency fingerprint, bounded concurrency, abort propagation, 단조 증가하는 SSE event, journal recovery를 보존한다.
- 브라우저 요청 handler 안에서 무거운 수집이나 전체 컴파일을 동기식 장기 작업으로 실행하지 않는다.
- correction 화면은 page, controller, workbench panel, drawer, player picker, editor registry의 기존 책임 경계를 유지한다.
- 타임라인은 JSON 이벤트 하나당 UI row 하나다. 숨은 주자 이동이나 파생 이벤트를 만들지 않는다.
- 고정 높이 virtual list에서 이동, 삭제, 선택은 필터링된 DOM이 아니라 canonical 전체 배열 index를 기준으로 한다.
- 선수 선택은 해당 팀/로스터 범위를 지키고 keyboard/listbox 접근성을 유지한다.

## 파일 워크스페이스와 운영 데이터 안전

`.data`의 의미는 다음과 같다.

```text
.data/
  original/<season>/<gameId>.json      # 최초 원본, 덮어쓰기 금지
  staging/<season>/<gameId>.json       # blocking finding 없음
  quarantine/<season>/<gameId>.json    # blocking finding 있음
  quarantine/source-failures/          # 소스 취득 실패 기록
  journals/                            # crash recovery
  exports/
  logs/
```

- 한 게임의 현재 문서는 staging 또는 quarantine 중 정확히 한 곳에 둔다.
- 빈 finding sidecar는 만들지 않거나 삭제한다.
- writer lock을 우회해 동시에 파일을 쓰지 않는다.
- 파일 교체는 임시 파일 쓰기, file fsync, atomic rename, directory sync 순서를 유지한다.
- correction journal은 crash 후 roll-forward할 수 있어야 하며 성공 후 제거한다.
- `.env`의 내용을 읽어 출력하거나 커밋하지 않는다. 예시는 `.env.example`을 기준으로 한다.
- `.data`, `.backups`, PostgreSQL volume은 사용자 데이터다. 일반 개발 작업에서 삭제, 초기화, truncate, 덮어쓰기하지 않는다.
- 기본 Compose project에 `docker compose down -v`를 실행하지 않는다.
- restore 또는 `-ConfirmDataReplacement`는 사용자가 명시적으로 요청하고 정확한 대상과 백업을 확인한 경우에만 실행한다.
- backup/restore는 파일 워크스페이스와 DB를 한 쌍으로 다룬다. writer를 중지하고 hash를 검증하며, DB 복구 실패 시 workspace swap도 rollback해야 한다.
- 테스트용 DB, network, volume, workspace는 고유 이름의 격리된 임시 자원으로 만든다. 정리는 그 테스트가 만든 정확한 자원에만 수행한다.

## 코드 작성 규칙

- Node.js 24와 `pnpm@10.15.1`을 사용한다.
- TypeScript strict 설정을 낮추지 않는다. 특히 `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, `isolatedModules`, `verbatimModuleSyntax`를 우회하지 않는다.
- `any`, non-null assertion, unchecked cast보다 schema decode, type guard, 명시적 분기를 사용한다.
- 선택 속성은 `undefined` 값을 억지로 넣기보다 필요할 때만 속성을 생성한다.
- 외부 입력 오류는 source/domain/persistence 중 맞는 범주와 안정적인 code로 표현한다.
- 시간, UUID, fetch, sleep 같은 비결정적 의존성은 주입해 테스트 가능하게 만든다.
- 배열과 객체 순서가 hash나 결과에 영향을 주는 곳은 명시적으로 정렬한다.
- 기존 오류나 사용자 변경을 관련 없는 리팩터링으로 덮지 않는다.
- formatting은 저장소 Prettier 설정을 따른다: double quote, semicolon, trailing comma, 100자 폭.
- 주석은 코드에서 바로 드러나지 않는 야구 규칙, 원자성, 권위 경계의 이유를 설명할 때 사용한다. 구현을 그대로 번역하는 주석은 피한다.

## 테스트와 검증

변경 전 관련 테스트를 읽고, 변경과 같은 계층에서 회귀 테스트를 추가한다. 핵심 야구 규칙과 변환기는 example 테스트뿐 아니라 property/invariant 테스트를 우선 고려한다.

빠른 검증은 변경 범위에 맞춰 수행한다.

| 변경 범위             | 최소 추가 검증                                     |
| --------------------- | -------------------------------------------------- |
| 계약/스키마           | contract 테스트, `pnpm schema:game:check`          |
| package import/barrel | `pnpm test:architecture`                           |
| compiler/야구 규칙    | 관련 unit/property/golden 테스트                   |
| collection            | normalization/fixture 테스트, 실제 Naver 호출 금지 |
| correction            | command/session/API/UI 테스트                      |
| persistence/replay    | 관련 unit 테스트와 `pnpm test:integration`         |
| 서버-웹 전체 흐름     | `pnpm test:e2e`                                    |
| hot path              | `pnpm performance`                                 |

완료 전 기본 품질 게이트는 다음과 같다.

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm schema:game:check
pnpm build
```

주의할 점:

- 기본 `pnpm test`는 DSN이 없으면 PostgreSQL 통합 테스트를 skip한다. DB 동작을 바꿨다면 통과한 unit suite만으로 완료 처리하지 말고 `pnpm test:integration`을 실행한다.
- `pnpm test:e2e`는 격리된 Compose project와 임시 workspace를 사용해야 하며 실 Naver 호출 없이 import, replay, journal recovery, backup/restore, UI smoke를 확인한다.
- 성능 기준은 compiler 평균 10ms 이하, p95 25ms 이하를 유지한다.
- golden hash나 fixture 변경은 결과를 눈으로 검토하고 의도된 계약 변화일 때만 갱신한다.
- host에 올바른 Node/pnpm이 없다면 깨끗한 Node 24 컨테이너에서 검증한다. Windows host의 `node_modules`를 Linux 컨테이너에 그대로 mount해 재사용하지 않는다.

## 변경 작업 순서

1. 관련 문서, 공개 API, 테스트와 실제 호출 경로를 읽어 현재 권위와 불변식을 확인한다.
2. 변경이 어느 계층의 책임인지 정하고 가장 작은 소유 모듈에 구현한다.
3. 계약 또는 projection 변경 여부와 downstream 소비자를 먼저 식별한다.
4. 결정론, 원자성, 소스 보존, blocking 동작을 검증하는 테스트를 작성하거나 수정한다.
5. 구현 후 관련 targeted 테스트를 실행한다.
6. 기본 품질 게이트를 실행하고, DB/전체 흐름을 건드렸다면 integration/E2E까지 실행한다.
7. 동작 또는 운영 절차가 바뀌면 `README.md`, 구현 명세, 관련 `docs/*.md`, 예시 설정을 함께 갱신한다.
8. 사용자 데이터와 무관한 파일만 변경되었는지 최종 diff와 상태를 확인한다.

## 완료 기준

다음 조건을 모두 만족해야 작업이 완료된 것으로 본다.

- 변경이 올바른 모듈 경계 안에 있다.
- 소스 증거가 손실되지 않고 파생 상태의 권위가 중복되지 않는다.
- 동일 입력의 이벤트 순서, findings, hash와 replay 결과가 결정론적이다.
- blocking 데이터가 staging 또는 sealed DB로 우회 유입되지 않는다.
- 파일 교체와 DB import의 원자성, sealed revision의 불변성이 유지된다.
- 계약, 코드, 테스트, 생성 스키마와 문서가 서로 일치한다.
- 관련 targeted 테스트와 필요한 저장소 품질 게이트가 통과한다.
- `.env`, `.data`, `.backups`, DB volume 등 사용자 데이터가 노출되거나 변경되지 않았다.

## 준수 사항

- Correction의 구현 오류가 발생되어 수정할 시 해당 데이터를 선수 정보, 팀 정보를 비식별 처리한 fixture로 만들고 이후에 같은 오류가 발생하지 않도록 회귀 테스트로 만든다.
