# 2026-09-13 남은 병목 개선

[추가 조사](2026-09-13-remaining-bottlenecks.md)의 다섯 항목을 구현했다. 원장·compiler 결과·DB
revision 계약은 유지하며 실행 위치와 검증 결과의 재사용, 목록 읽기만 개선했다.

## 변경 내용

1. 재생 목록은 `authority=database`만 요청하고 전체 catalog와 query key를 구분한다.
   상위 catalog 무효화는 함께 적용된다.
2. 보정 명령, 사본 열기·undo/redo의 compile, 수집 정규화, 적재 전후 compile을 동일한 공개
   compiler를 호출하는 지속 worker 2개로 분리했다. 시작 중 worker를 준비하며 대기는 32개,
   실행은 60초로 제한한다. 과부하는 명시적 503이다. 세션 mutex는 계산 완료까지 유지하고
   worker 실패 시 undo/redo·문서·version을 바꾸지 않는다. 수집 취소는 대기·실행까지 전달한다.
   파일 writer와 DB transaction은 기존 소유자가 유지하며 내부 재compile 실패도 전체 rollback한다.
3. 기록정정 제안은 worker별로 같은 원장 하나의 strict compile을 공유한다. builder는 원장 사본을
   소유하고 반환값도 복사하므로 호출자 변경이 다음 제안을 오염시키지 않는다. 서버는 문서 hash,
   공지 전체 내용, binding에 결합한 검증 결과를 8MiB/128개, 컴파일 결과를 16MiB/16개까지
   5분간 재사용한다. 현재 문서·source finding·DB base 확인은 매 조회 유지한다.
4. 투수 분석 표본은 시즌 sourceHash·투수·모델/reference 버전별 32MiB/32개, idle 5분 캐시를
   사용한다. 매 요청 새 repeatable-read snapshot에서 시즌 revision 목록을 확인하고, 최초 loader는
   그 snapshot에서 기준·투구를 읽는다. 같은 hash의 동시 계산은 공유하고 응답은 복사한다.
   표본·기준 궤적 계산은 worker 1개·대기 16개로 제한하며 시즌 행은 5,000개씩 전달한다.
5. 적재 이력 복구의 파일 읽기를 최대 16개로 병렬화했다. hash/decode, 파일명 순서, 오류의 순서는
   유지한다. 목록은 생성 시각·ID의 정렬을 재사용하고 최신 job 상태를 읽는다. 반환할 페이지만
   복사하고 빈 검색어의 문자열 변환 및 상태별 반복 집계를 없앴다.

## 검증

- 전체 단위·UI suite: 692개 통과. DSN이 없는 41개 PostgreSQL test는 별도 실행했다.
- 격리 PostgreSQL integration: 41개 통과. worker 재compile 실패의 전체 rollback,
  동일 snapshot 표본 공유·응답 격리·새 revision 재계산을 포함한다.
- 격리 Compose E2E: restart, journal recovery, import, replay, backup/restore, 분석·보정 UI 통과.
  Chromium page error 0건. 재시작 뒤 분석 기준 파일의 hash·수정 시각도 유지됐다.
- 마지막 worker 준비 및 503 response schema 변경 뒤 관련 API·worker·architecture 30개 재검증 통과.
- lint, format:check, typecheck, schema:game:check, build 통과.
- `pnpm performance`: 558-event compiler 평균 5.751ms, p95 8.952ms로 10/25ms 기준 통과.

## 격리 성능 측정

Windows Node 24에서 다른 품질 검사와 이미지 빌드가 끝난 뒤 측정했다. 수치는 표본 중앙값이며
전체 운영 요청의 p95나 모든 시즌의 예상 시간은 아니다.

| 항목                        | 이전 경로 | 개선 경로 | 조건                                         |
| --------------------------- | --------: | --------: | -------------------------------------------- |
| 큰 경기 계산 중 타이머 대기 |    95.6ms |     1.7ms | 873 events, worker 준비 후 각 10회           |
| 보정 계산 자체의 완료 시간  |    95.4ms |   126.0ms | 같은 명령·같은 결과, 전송 비용 포함          |
| 적재 이력 목록              |    34.1ms |     0.6ms | 메모리 이력 10,000건, 50건 페이지, 20회      |
| 이력 파일 hash/decode       |   178.9ms |    45.9ms | 격리 파일 1,008개, 순차/16개 읽기를 교대 5회 |

worker 분리는 계산 중 다른 요청을 처리할 여유를 만드는 변경이다. 메시지 복사 비용이 있어서
보정 명령 하나의 완료 시간까지 항상 줄어들지는 않는다. 기존 이력 목록 알고리즘은 같은 fixture로
재현해 비교했으며 실제 운영 적재 이력 1만 건을 생성한 것은 아니다. 파일 읽기의 두 경로는
동일 hash/decode 함수를 사용하고 결과 순서까지 비교했다.

기록정정 공유 builder와 기존 단건 함수의 결과 일치·호출자 mutation 격리는 비식별 fixture로
검증했다. 작은 fixture의 반복 실행 시간은 실제 여러 시즌 공지 목록 지연으로 일반화하지 않는다.
운영 DB가 비어 있으므로 분석의 대규모 SQL 실행 시간은 이번 수치에 포함하지 않는다.

측정 스크립트·JSON과 integration/E2E 로그는 무시되는 `test-results/remaining-fixes-20260913/`에 있다.
실제 제공자 수집, 운영 교정 commit 또는 DB import는 검증에 사용하지 않았다.

## 실행 서버 적용과 최종 확인

진행 중인 수집·적재·기록정정 작업과 미저장 사본이 없는 상태에서 API와 웹을 새 이미지로 전환했다.
시작 무결성 검사와 worker 준비를 마치고 약 127.9초 뒤 ready가 됐다. 운영 current manifest
4,698개를 전후 hash 비교했으며 모두 동일했다. DB volume·수집 원장·원본을 교체하지 않았다.

최대 표본의 임시 메모리 사본에서 `apply:false` 명령을 보내는 동안 `/health/live`를 함께 조회했다.
각 5회에서 한 명령 동안 관찰한 최대 조회 지연의 중앙값은 **134.8ms → 35.9ms**였다.
같은 시험의 보정 명령 전체 시간 중앙값은 **160.9ms → 194.6ms**였다. worker 전송과 응답 복사 비용이
있으므로 동시 화면 응답성이 좋아진 것과 명령 단독 완료 속도는 구분해야 한다. 임시 세션은 삭제했다.

실제 Chromium의 재생 화면은 `/api/v2/games?authority=database` 한 경로만 요청했고 전체
catalog 요청은 없었다. 현재 DB 0건의 응답은 12 bytes, 9.1ms였다. 대시보드·DB·보정·재생 페이지와
큰 경기의 행 선택에서 page error는 없었다. 873 events는 DOM 10행으로 표시됐고 clean 사본은
이탈 시 DELETE 후 404로 확인됐다. 최대 사본 첫 표시에는 56ms long task 하나가 있었으며,
이후 행 선택 5회에는 없었다. 원문 최초 전체 검증은 약 449ms로 남아 있고 반복 행 조회는 3.6~5.2ms였다.
