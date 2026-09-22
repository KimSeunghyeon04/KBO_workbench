# 2026-09-13 로스터 보완 구현과 기존 수집본 적용

사용자의 기존 수집 데이터 반영 요청에 따라 로스터 누락 27경기를 저장된 source bundle로 다시
정규화했다. 경기별 로스터에 총 142건을 추가했고 모두 전체 strict compile의 차단 finding이
0건으로 확인되어 적재 가능 상태로 저장했다. 142건은 경기별 선수 등록 합계이며 고유 선수 수가 아니다.

## 구현

- collection의 roster-supplement가 preview 로스터와 같은 경기 record 박스스코어를 대조한다.
- 명시 ID·이름·팀을 확인한 누락 선수만 ID순으로 추가한다. 원본 bundle과 기존 로스터를 유지한다.
- 새 선수의 선발·타순은 추정하지 않는다. 투수 기록 참가만 투수 포지션의 근거로 사용한다.
- 같은 ID의 타자/투수 기록은 하나로 합치며 이름만 같은 다른 ID는 병합하지 않는다.
- 반대 팀 및 ID 별칭 충돌, 누락 선수 이름 근거 충돌/부재는 blocking이다.
- 기존 preview 선수의 이름을 박스스코어의 축약 표시 이름으로 다시 식별하지 않는다.
- 각 보완 record 배열 경로·행 위치를 persistent source warning으로 보존한다.

## 적용 검증

- 적용 직전 4,698개 current manifest의 hash를 고정하고 대상 27건이 최초 수집본과 동일한지 확인했다.
- 대상은 모두 new_game이며 DB catalog에는 봉인 경기가 0건임을 확인했다.
- API writer를 중지하고 StagingWorkspace writer lock을 획득해 전체 workspace 무결성을 검증했다.
- 모든 대상의 원본 hash와 저장된 source endpoint/bundle hash를 검증하고 적용 계획과 재정규화 hash를 대조했다.
- 중계 행의 identity·sequence·원문과 기존 로스터가 보존되는지 비교했다.
- saveReady의 전체 compile, current token CAS, journal 및 versioned transition을 사용했다.
- 기존 작업본은 superseded로 보존했다. 적용 후 old/new hash와 original/source를 다시 확인했다.
- current manifest 변경은 정확히 27개이며 다른 4,671개는 동일하다. 검토 필요 목록은 76→49경기다.
- DB 적재, source 재수집, source/original 덮어쓰기는 수행하지 않았다. 이전 리뷰에서 수정한 별도
  구현 오류 5경기의 저장본 재정규화는 이번 로스터 적용 대상에 포함하지 않았다.

저장 시각: 2026-09-13T08:54:03.480Z. 기존 차단 finding 6,959건은 연쇄 오류를 포함한 수이며 독립 오류 수가 아니다.

| 경기 ID           | 추가 로스터 | 이전 차단 | 저장 후 차단 |
| ----------------- | ----------: | --------: | -----------: |
| 20200530HHSK02020 |          13 |       764 |            0 |
| 20200530KTWO02020 |          16 |       821 |            0 |
| 20200530LTOB02020 |          18 |       821 |            0 |
| 20200530NCSS02020 |          14 |       534 |            0 |
| 20200613OBHH02020 |           1 |       105 |            0 |
| 20200818KTSS02020 |           1 |         4 |            0 |
| 20200826WOKT02020 |           1 |       111 |            0 |
| 20200828OBNC02020 |           1 |        70 |            0 |
| 20200829OBLG02020 |           1 |        79 |            0 |
| 20201003WOSK02020 |           1 |        60 |            0 |
| 20210627SKNC02021 |           1 |        17 |            0 |
| 20220315HTSS02022 |           1 |       132 |            0 |
| 20220520HHWO02022 |           6 |       326 |            0 |
| 20220520KTSS02022 |          10 |       433 |            0 |
| 20220520LGSK02022 |          15 |       532 |            0 |
| 20220520LTOB02022 |           8 |       435 |            0 |
| 20220520NCHT02022 |           9 |       453 |            0 |
| 20230528LGHT02023 |           1 |        27 |            0 |
| 20230613OBNC02023 |           1 |       128 |            0 |
| 20230627LGSK02023 |           1 |        87 |            0 |
| 20230707WOOB02023 |           1 |        73 |            0 |
| 20230709SKHH02023 |           1 |        32 |            0 |
| 20230712LTNC02023 |           1 |        36 |            0 |
| 20230922LTSK02023 |           1 |        70 |            0 |
| 20231001NCHH02023 |           1 |        32 |            0 |
| 20231008HHKT02023 |           1 |       190 |            0 |
| 55551027LGWO02022 |          16 |       587 |            0 |

## 테스트

- 실제 누락 구원투수 교체·후보 타자 기록 형태를 축소한 비식별 fixture와 collection 회귀 테스트 14개 통과.
- 전체 99 test files, 665 tests 통과. DB 통합 38개는 기본 suite에서 skip했으며 이번 변경에 DB 코드/계약 변경은 없다.
- typecheck, format:check, schema:game:check, build 통과. Docker API 이미지 build 통과.
- 전체 lint는 기존 test-results 실험 파일의 133개 오류로 실패했다. test-results를 제외한 제품·테스트 lint는 통과했다.
- 상세 적용 계획과 검증 결과는 Git 제외 경로 test-results/quarantine-review-20260913의
  roster-apply-plan.json, roster-applied.json, roster-*.log에 있다.

## 웹 요청 실패 진단

작업 도중 API 컨테이너가 17:46 KST에 다시 시작된 상태에서 웹 gateway의 upstream connection refused와
502 응답을 확인했다. 시작 전 current 작업본 전체를 검증하므로 이 구간에는 API가 아직 listen하지 않는다.
로스터 반영 전에 발생했으며 운영 DB는 healthy였다. 새 API는 17:54에 시작해 약 3분 34초 뒤
17:57에 listen했고 API·web·DB 모두 healthy로 확인됐다. 시작 전 검증 절차 자체를 변경하거나
우회하지 않았으므로 이후 재기동 시에도 준비 구간이 있다.

17:59 KST에 localhost:8080을 통한 readiness, system status, dashboard, 기록정정 summary,
collection jobs, 적재 가능 목록, 검토 필요 목록, DB 목록의 8개 요청 모두 HTTP 200을 확인했다.
API 목록은 ready 4,645, quarantine 49, DB 0건이며 source failure는 별도로 4건이다.
반영한 27경기를 API에서 다시 가져와 strict decode·문서 hash·전체 compile의 차단 0건을 재검증했다.
실행 이미지의 mapper와 roster-supplement 출력 파일 SHA-256도 검증한 host build와 일치한다.
세부 응답 결과는 `roster-http-verified.json`에 있다.
