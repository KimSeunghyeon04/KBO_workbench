# 품질 요약 저장과 비동기 준비

## 동작

자료 품질 GET은 현재 원천을 확인한 뒤 저장 요약을 반환한다. 요약이 없으면 202와
`state: preparing`, 조회 scope, sourceKey를 반환하고 서버에서 준비한다. 화면은 1초 간격으로
확인하며 완료 응답은 기존 `AnalysisCoverageResponse`와 같은 값·hash·분모를 유지한다.
실패는 `state: failed`로 표시하고 `POST /api/v2/analysis/coverage/prepare`로 다시 준비한다.
POST도 동일한 query를 사용한다. 동일 원천의 진행 중 요청과 완료된 요청은 중복 계산하지 않는다.

준비 작업은 동시 1개, 대기 16개이며 보정 계산은 기존 분석 worker를 사용한다. 대기 작업은
원시 투구를 보유하지 않는다. 같은 시즌·경기 종류의 날짜 필터들은 한 작업을 공유한다.
개별 화면을 닫아도 공유 준비는 이어지며 서버 종료는 대기 작업을 버리고 실행 signal을 취소한다.
실행 중 SQL은 기존 30초 statement timeout 안에서 끝나며 SQL 이후 계산/공개를 취소한다.
실패 상태는 최대 32개 작업 범위에 보관한다. 재시작 시 미완료 계산은 다음 조회에서 다시 준비한다.
자동 모델 학습 정책과 별개인 파생 요약이며 수집·학습·봉인 기록 쓰기를 실행하지 않는다.

## 저장·무효화와 모듈 경계

- `AnalysisCoverageRepository`: 같은 read-only repeatable-read snapshot의 원천·유효 신장 확인,
  필요한 SQL 집계와 투구 입력 읽기. 계산 전 DB 연결을 반환한다.
- `analysis-coverage-summary`: 경기별 집계와 조회 기간의 응답 구성. 궤적/보정 판정은 기존
  계산 함수를 사용하며 야구 상태를 재계산하지 않는다.
- `AnalysisCoverageWorkspace`: `analysis/coverage/<sourceKey>.json`의 strict decode·내용 hash·
  경기별 합계 검증, writer 소유권 확인과 원자 저장. 파일은 최대 16MiB이며 손상은 cache miss다.
- 서버의 전용 준비 manager: 중복 병합·대기 상한·실패·재시도·종료를 관리한다.
  별도 서비스나 범용 작업 프레임워크는 추가하지 않았다.

sourceKey는 시즌·경기 종류, current revision/document hash, 분류 dataset, 시즌 유효 신장,
보정 파라미터, `COVERAGE_SUMMARY_VERSION`으로 결정한다. 궤적·존·집계 정의가 바뀌면 이 버전을
올려야 한다. 매 요청에서 신선한 키를 확인하며 TTL은 메모리 보관에만 사용한다.
메모리 요약은 최대 16MiB/16건/미사용 5분이다.

시즌 요약은 경기별 수를 저장하므로 기간 필터 변경은 원시 투구를 다시 읽지 않는다.
다른 시즌의 추가·정정은 기존 시즌 요약에 영향을 주지 않는다. 영향 있는 시즌은 다시 준비하며
같은 trajectory 원천의 보정 파일은 재사용한다. 보정이 과거 여러 경기의 창을 사용하므로 경기
한 건이 바뀌었을 때 그 경기만 다시 계산하는 방식은 사용하지 않는다.
계산 도중 원천이 바뀌면 옛 결과는 옛 sourceKey 파일로만 저장되어 다음 조회에서 사용되지 않는다.
원본·현재 원장·sealed facts와 학습 모델은 변경하지 않는다.

## 실제 자료 검증

기존 격리 DB에서 품질·구종 기대 효과·운용 비교 HTTP 응답을 이전 결과와 대조해 모두 같은 hash를
확인했다. 새 보정/요약 cache에서 최초 상태 응답은 321ms, 준비 완료는 13,726ms였다.
반복 품질 조회 30회 p95는 214ms, 새 route instance에서 저장 요약을 읽은 조회는 228ms였으며
추가 준비 polling이나 보정 계산이 없었다.

준비 완료 시간에는 상태 polling을 포함한다. 첫 측정은 다른 검증 프로세스가 실행 중이었으므로
이전 10초 측정과 계산 성능 비율을 비교하지 않는다. 이번 개선은 첫 조회의 상태를 빠르게 보여주고
기간 변경·재시작 때 전체 시즌 계산을 반복하지 않는 것이다. 새 자료의 첫 계산 자체는 여전히 필요하다.
`analysis:audit`는 최초 상태 응답 시간과 완료 시간을 구분하며 재시작에 해당하는 새 route의
저장 요약 재사용도 검증한다.

실행: `analysis/validation/4ab857f2-7a6c-4ffb-b971-80e94924b517/audits/05783469-c2ce-4b61-b436-f16bb1a4312f/`.

## 회귀 검사

단위/API/UI 889개, 격리 PostgreSQL 통합 75개, 검증 도구 7개와 architecture·lint·format·
typecheck·schema·build가 통과했다. 격리 Compose E2E에서 브라우저 분석 화면·모델 작업·
재시작·backup/restore가 통과했다. compiler 평균 4.669ms, p95 6.330ms로 기존 기준을 유지했다.

회귀 범위는 파일 손상·source/정의 버전·합계 불일치, writer 소유권·취소 후 미공개, 같은 원천의
준비 병합·대기 상한·실패 재시도, 날짜 필터 재사용·다른 시즌 독립성·revision/분류/신장 무효화다.
완료 결과와 준비 상태는 strict 계약으로 구분하고 다른 조회 범위의 응답은 웹에서 거부한다.

## 운영 반영

API·웹에 반영한 뒤 최초 품질 상태 응답은 182ms, 완료까지 3,954ms였다. 기존 보정 파일을
재사용했으며 새 품질 요약 파일을 준비했다. 운영의 품질·구종 기대 효과·운용 비교 응답 hash는
격리 결과 및 배포 전과 같았다. 데스크톱/모바일 브라우저에서 기간 변경이 준비 작업 없이 200으로
응답했고 page error는 0이었다.

2023–2025 모델 16개, current/active 원장 파일 11개와 sealed revision 4,693개의 hash를 유지했다.
migration head `0012_competition_game_links`와 자동 모델 갱신 비활성 상태도 유지했다.
배포 기록은 `analysis/deployment/20260921-coverage-summary/`에, 복귀 이미지는
`kbo-workbench-api:before-20260921-coverage`와 대응 web 태그에 보존했다.

실제 운영 API를 다시 시작한 직후 품질 조회는 **247ms에 200**을 반환했다. 준비 polling은 0회였고
저장 요약의 응답 hash는 재시작 전과 같았다. 기존 모델 16개와 원장·sealed hash 및 컨테이너
건강 상태도 재확인했다. 이는 해당 장비에서의 단일 관측값이며 p95 보장은 아니다.
