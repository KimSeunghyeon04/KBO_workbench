# 테스트와 성능 기준

## 품질 명령

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm performance
pnpm schema:game:check
pnpm build
docker compose config
docker compose build
```

`test:integration`은 고유한 PostgreSQL 16 container와 network를 만들고 fresh V3 migration head,
revision 1→2 적재 transaction, typed 재조회·compile·projection hash, 과거 revision 불변, stale base,
seal/current pointer, catalog identity FK, tracking 단일 저장, registry snapshot/stint와 analyst 권한을
검증한다. 종료 시
자신이 만든 container와 network만 제거한다.

`test:e2e`는 고유 Compose project와 임시 port·data·volume을 사용한다. 실제 Naver network는 호출하지
않고 sanitized fixture로 수집 원장 저장, 보정, import, typed replay, backup/restore와 UI smoke를
검증한다.

## 필수 회귀 범위

### 수집 원장

- Naver 의미 행 하나가 평면 원장 행 하나로 보존됨
- 판독·공지·휴식·footer와 `unresolved`가 유실되지 않음
- 한 행 실패 뒤 후속 중계와 다음 반이닝이 끝까지 남음
- 누락 타석 시작·결과·주자 행을 합성하지 않음
- 의미 있는 재전송도 원천 위치별 원장 행으로 모두 보존함
- source 위치, 원문, 선수·판정·관측 상태가 strict round-trip에서 유지됨
- JSON 필드 순서, unknown/cosmetic 필드와 공백 정규화가 semantic 결과를 바꾸지 않음
- 같은 강도의 선수·결과 근거가 충돌하거나 동명이인을 좁힐 수 없으면 `unresolved`가 됨
- 반복 행의 결정적 identity와 finding code·원천 위치 evidence가 안정적임
- staging 재수집 제외가 한 번의 batch 진행으로 반영되고 외부 수집과 경기별 journal 쓰기를 하지 않음
- source endpoint payload와 manifest가 canonical gzip bundle로 불변 저장됨
- 한 투구의 완전 동일 tracking 재전송은 첫 관측 linked·나머지 duplicate이며 모든 source 위치가 보존됨
- 같은 `sourcePitchId`가 다른 PA·ordinal에서 서로 다른 실제 투구에 연결됨
- 동일 문맥 metric 충돌, 개수 불일치, orphan, pending과 다중 canonical link가 차단됨
- 같은 ID 반복과 PTS ordinal 차이는 warning이고 blocking이 아님

### Compiler와 야구 규칙

- 타석 결과가 타자 기본 상태만 파생하고 기존 주자는 실제 `runner_advance`만 반영함
- 연결 주자 행의 원자적 임시 상태 검증과 실패 시 부분 적용 없음
- dangling link, 잘못된 독립 사유, 사이에 상태 변경 행이 있는 연결을 차단함
- 주루사 3아웃 partial과 3아웃 미만 `source_half_incomplete`를 구분함
- completed/partial PA, 실제 투구 수와 다음 반이닝 event bridge가 정확함
- force/time play, appeal, apparent fourth out, 책임 투수와 교체 규칙이 유지됨
- 공식 기록 비교와 계산 기록이 결정적임
- movement engine 실패 뒤 입력 베이스·아웃·책임 주자 객체가 변경되지 않음

### 아키텍처

- package root의 `export *`와 package deep import가 없음
- `game-core`에 provider 이름·한국어 lexical 정규식·UI·DB adapter가 없음
- production collection 코드에 특정 경기 ID·fixture 위치 분기가 없음
- Fastify composition root와 route plugin, 보정 page와 controller/editor/component 경계가 유지됨

### 보정과 UI

- 원장 행 추가·교체·삭제·이동이 각각 undo/redo 한 단위임
- 매 명령 뒤 전체 compiler finding으로 교체됨
- `unresolved` 변환 시 원문과 source identity가 유지됨
- 타석 결과와 주자 이동 편집기가 분리됨
- 선수 검색, 중계 문구, keyboard 접근성과 stale session 거부가 동작함
- 차단 draft는 quarantine에만 저장되고 DB import가 거부됨
- tracking link/duplicate/exclude/unlink와 중복 그룹 batch가 실제 pitch 1:tracking 0..1을 보장함
- 수집 SSE의 비변경 진행은 작업 목록만 갱신하고 catalog query 폭주를 만들지 않음
- 784개 DB·기록정정·작업 목록은 2,000 미만 DOM node를 유지하고, 선택 전 revision/공지 상세 요청은
  0회이며 선택한 항목 endpoint만 한 번 호출함
- 수집·기록정정·Database의 URL 직접 진입, 새로고침과 뒤로/앞으로가 검색·범위·선택을 복원함
- 운영 콘솔 목록 행에 finding 수나 반복 행동 버튼이 없고, 기록정정 처리 뒤 다음 미처리 항목과 남은
  수를 표시함
- 1280×720에서 목록·상세가 한 화면 작업영역에 있고 390×844에서는 목록→상세→뒤로로 전환하며
  가로 scroll과 상세 끝에 묻힌 주요 행동이 없음
- 수집·재생 catalog는 viewport와 overscan만 렌더링하고, 재생 listbox는 canonical filtered index와
  `aria-activedescendant`, `aria-setsize`, `aria-posinset`을 유지함
- production build는 route별 lazy chunk를 만들고 500KB 초과 chunk 경고가 없음

### PostgreSQL과 재생

- strict 원장 decode부터 새 revision seal/current 전환까지 한 transaction으로 처리됨
- 원장 fact와 최종 pitch·tracking·play·movement·PA·상태·선수 기록이 typed 컬럼에 저장됨
- DB 재조회 원장을 다시 compile한 결과가 저장 projection과 같음
- revision 1→2, 과거 revision 불변, stale base 거부와 transaction rollback이 보장됨
- 타석 결과와 연결 주자 행이 한 원자적 replay frame으로 표시됨
- replay와 분석이 staging JSON 복원 없이 typed fact만 사용함
- current/all-revision, 선수 시즌 집계, NULL denominator와 zone/chase query가 정확함
- catalog source identity FK와 canonical mapping 변경이 sealed projection hash를 바꾸지 않음
- tracking scalar가 원천 관측에 한 번만 저장되고 pitch link에 복제되지 않음
- registry 등록 공백을 넘는 stint가 없고 개명·등번호 event가 소속 stint를 바꾸지 않음
- V2 current revision 1→2가 V3 revision 1로 전환된 뒤 최신 원장과 replay 의미가 같음

## Python fixture 기준

기존 `KBO_scrapping_analysis/tests/v3`의 Naver runner·누락 타석·partial PA·교체·tracking·보정
fixture는 TypeScript 회귀 기준으로 포팅한다. Python 객체 형태를 유지하는 것이 아니라 같은 원천
사실이 평면 원장 행, compiler play, 최종 상태·기록과 finding으로 올바르게 변환되는지를 고정한다.

특히 다음 실경기 유형을 네트워크 없이 검증한다.

- 실책 뒤 동일 base 유지와 파울 플라이 포구 실책
- 대타 heading, 동명이인, 타석 중 대타와 DH 해제
- 병살 시도 1아웃, 병살 뒤 추가 태그 3아웃과 time play 득점
- 야수선택 뒤 prior-pitcher 책임 슬롯
- 원천 한 행 누락 뒤 후속 타자·반이닝 보존
- 반복 행 묶음과 직전 반이닝 결과 혼입
- 동일 `sourcePitchId`의 서로 다른 투구와 tracking 관측

## Event windowing

보정 timeline은 고정 row 높이, viewport, scroll과 overscan으로 visible window만 렌더링한다. 필터와
무관한 canonical 원장 순서 이동은 DOM이 아니라 전체 event 배열을 기준으로 계산한다.

## Replay 성능

```powershell
pnpm performance
```

production build 뒤 fixture를 warm-up하고 반복 측정한다. 기본 기준은 평균 10ms 이하, p95 25ms
이하다. 브라우저 재생 tick은 이미 받은 typed frame index만 바꾸며 API나 compiler를 다시 호출하지
않는다.
