# 2026-09-13 추가 병목 조사

[직전 개선](2026-09-13-remaining-bottleneck-fixes.md) 뒤 남은 경로를 조사했다. 원문 최초 검증,
DB projection의 정규화·해시, 보정 응답 생성에 동기 CPU 비용이 남아 있다. 분석 worker의
누적 배열 복사도 데이터 증가에 따라 비용이 빠르게 커진다. 이번에는 제품 코드를 수정하거나
배포하지 않았다.

## 측정 범위

- 운영 API는 localhost에서 조회했다. 원문 시험은 큰 경기의 임시 메모리 세션을 열어 5회
  반복하고 매번 삭제했다. 명령은 동일 위치를 지정하는 `apply:false`이며 commit하지 않았다.
  종료 후 열린 세션 0개를 확인했다. 수집·DB import·실제 제공자 호출·재시작은 실행하지 않았다.
- 별도 Windows Node 24 프로세스에서 수집 원장 3개와 해당 원본을 읽었다. 원장 크기 기준
  중앙·p95·최대 표본은 각각 540/668/873 events다. 원본 크기의 순위와는 다르다.
- 원문 단계는 5회, projection·문서 처리 단계는 준비 실행 후 10회 측정했다. 모든 수치는 표본
  중앙값이며 운영 요청 전체의 p95가 아니다. 로컬 CPU 시간과 컨테이너 HTTP 시간을 합산하지 않는다.
- DB 적재 경기는 현재 0건이다. SQL 실행과 대규모 실제 분석의 완료 시간은 측정하지 않았다.
- 스크립트와 원시 결과는 무시되는 `test-results/deeper-bottlenecks-20260913/`에 보관했다.

## 1. 원문 최초 검증이 다른 HTTP 요청을 지연시킴 — 현재 우선

큰 표본의 원문 첫 조회는 **441.8ms**, 캐시가 있는 직후 조회는 **19.6ms**였다. 첫 조회 중
동시에 보낸 `/health/live`의 최대 지연은 회차별 134.9~206.1ms이며 그 중앙값은 **156.8ms**다.
별도의 무부하 상태 조회 중앙값은 6.0ms였다.

`readSourceBundle`은 압축 해제 후 endpoint마다 JSON을 다시 canonical 직렬화하고, 모든 endpoint를
묶어 bundle canonical 직렬화·hash를 다시 수행한다. 이 CPU 작업은 API 스레드에서 실행된다.
별도 프로세스에서 2.54MB 원본의 endpoint canonical 검사 108.5ms, 전체 bundle canonical/hash
119.9ms를 측정했다. 캐시 등록의 용량 계산에도 전체 JSON 직렬화가 필요했다.

최초 원본 읽기·검증을 용량과 동시성이 제한된 worker에 맡기고, 검증된 결과와 byte 수를 함께
반환하는 방향이 적합하다. endpoint 및 bundle hash, canonical 검사 자체를 생략하면 안 된다.
기존 캐시는 반복 조회를 해결했지만 캐시가 비어 있는 첫 요청의 CPU 점유까지 해결하지는 않았다.

근거: [원본 읽기](../../packages/persistence/src/staging-workspace.ts),
[원문 캐시 호출](../../apps/server/src/correction-session-manager.ts),
[캐시 용량 계산](../../apps/server/src/bounded-read-cache.ts).

## 2. DB 적재의 projection 정규화·해시가 API에 남음 — 대량 적재 전 우선

| 표본 events | DB fact 행 | projection 생성 | 정규화·hash 단독 |
| ----------: | ---------: | --------------: | ---------------: |
|         540 |      3,949 |         101.8ms |           99.8ms |
|         668 |      4,812 |         125.3ms |          114.4ms |
|         873 |      6,225 |         173.1ms |          163.4ms |

각 열은 별도 실행한 시간이며 서로 더하는 값이 아니다. `hashProjectionTables` 측정에는
행 형태·scalar 정규화와 canonical 직렬화가 포함된다. SHA-256 연산만 163ms라는 뜻은 아니다.

컴파일은 worker로 이동했지만 projection 생성, DB 재조회 fact의 hash, 내부 원장 재구성 뒤
projection 생성은 아직 동기식이다. 한 번 적재할 때 서로 다른 검증 단계에서 이 비용이 반복된다.
위 수치는 DB 연결 없는 CPU 측정이므로 실제 적재 전체 시간이나 다른 HTTP 요청의 지연은 아니다.

projection 생성·검증 계산도 worker로 분리하고, 행마다 다시 만드는 column set 등 중복 준비를
줄일 수 있다. transaction·DB 재조회·원장 재compile·seal 검증은 그대로 유지해야 한다.

근거: [projection 생성·hash](../../packages/persistence/src/projection.ts),
[적재와 재검증](../../packages/persistence/src/revision-store.ts).

## 3. 보정 응답 생성과 전체 문서 전달 — 현재 보정 체감 속도

이미 계산한 유효한 결과를 공급하는 격리 세션에서, 새 version의 응답을 만드는 처리만
**68.7ms**가 걸렸다. compiler·worker 전송·HTTP 전송을 제외한 값이다. 문서 hash, canonical
복사·strict decode, 전체 event context 생성 및 응답 복사가 여기에 남아 있다.

873-event 세션 JSON은 **1,084,110 bytes**다. `apply:false`에서도 413-byte preview와 함께
변경되지 않은 전체 세션을 보내 응답이 1,084,546 bytes가 됐다. 크기는 압축 해제 후 JSON이다.
현재 웹의 일반 명령은 `apply:true`를 쓰므로 preview만 줄여서 일반 보정 지연이 해결된다고
볼 수는 없다.

응답용 snapshot 계산을 worker 결과에 포함하고 같은 version의 검증 결과를 재사용하는 것이
우선이다. 추가로 session version/hash에 결합한 상세 조회 분리나 응답 축소를 검토할 수 있다.
브라우저가 자체적으로 원장을 낙관 수정하거나 전체 compile을 생략하는 방식은 피한다.

근거: [세션 snapshot](../../apps/server/src/correction-session-manager.ts),
[보정 controller](../../apps/web/src/correction/use-correction-session-controller.ts).

## 4. 분석 worker의 누적 배열 복사 — 대규모 표본에서 커지는 비용

5,000행씩 받은 chunk를 합칠 때 `[...previous.rows, ...input.rows]`로 이전 행 전체를 매번
복사한다. 고정 chunk 크기에서 누적 복사량은 전체 행 수의 제곱에 비례한다.

| 합칠 행 수 | 현재 복사 방식 | 한 번씩 추가하는 비교 방식 |
| ---------: | -------------: | -------------------------: |
|    100,000 |          3.9ms |                      0.5ms |
|    250,000 |         28.7ms |                      1.2ms |
|    500,000 |        112.2ms |                      3.7ms |

공유하는 작은 객체의 참조를 합치는 합성 측정 5회다. 실제 시즌 행·메시지 전송·SQL·모델 계산을
포함한 성능 개선치는 아니다. 실제로 worker 안에서 발생하므로 HTTP 직접 점유보다 분석 완료
시간과 임시 메모리·GC 비용의 문제다. worker가 소유하는 배열에 순서대로 추가하거나 chunk를
보관했다가 한 번 합치면 된다. 최근 분리한 분석 worker에 남은 구현상의 개선점이다.

근거: [worker 메시지 조립](../../apps/server/src/computation-worker.ts).

## 5. 요약·수집 이력의 전체 조회 — 현재보다 데이터 증가 시 대비

대시보드와 DB 상태 조회는 현재 각각 30.5ms, 30.7ms여서 앞선 CPU 구간보다 우선순위가 낮다.
다만 숫자 집계에 DB 전체 catalog를 읽으며, 대시보드는 5초마다 dashboard와 system status를
함께 요청해 DB·브라우저·workspace 상태 검사도 중복 실행한다. 정상 DB에서는 두 요청에
각각 3개의 DB 상태 확인 SQL이 필요하다.

수집 이력 목록도 모든 history 파일을 읽고 hash/decode·정렬한 뒤 페이지를 자른다.
이미 최대 16개 병렬 읽기이므로 순차 파일 읽기가 남았다는 문제는 아니다. 결과 항목 캐시와
별개로 이력 목록 전체 읽기가 반복되는 점이 남았다. 이력 상세의 한 페이지를 위해 전체
inventory를 다시 만드는 비용도 있다.

요약 전용 DB 집계/ID 조회, 짧은 상태 검사 공유, writer 변경으로 무효화하는 제한된 이력
인덱스가 후보이다. 실제 DB·이력이 늘어난 조건의 지연시간은 아직 검증하지 않았다.

근거: [시스템 route](../../apps/server/src/routes/system.ts),
[대시보드 polling](../../apps/web/src/pages/dashboard-page.tsx),
[DB 상태 검사](../../apps/server/src/database.ts),
[수집 목록·이력](../../apps/server/src/collection-operations-service.ts),
[수집 이력 파일 읽기](../../packages/persistence/src/collection-workspace.ts).

## 권장 순서

원문 첫 검증과 보정 snapshot을 먼저 분리하면 현재 보정 화면의 지연에 직접 대응할 수 있다.
대량 DB 적재 전에 projection 정규화·hash를 분리하고, 분석 배열 복사는 작은 변경으로 함께
개선할 수 있다. 요약과 이력 인덱스는 데이터 증가에 대비해 다음 순서로 처리한다.

이번에는 조사 문서만 추가했으며 품질 전체 suite는 재실행하지 않았다. 측정 스크립트 실행,
HTTP 응답 성공, 임시 세션 정리와 문서 formatting을 확인했다.
