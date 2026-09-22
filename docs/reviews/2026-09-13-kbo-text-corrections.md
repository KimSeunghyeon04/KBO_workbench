# 2026-09-13 KBO 문자 중계 대조 및 검토 문서 보정

현재 검토 필요 문서 49경기를 대상으로 KBO 공식 문자 중계·박스스코어 대조 작업을 진행했다. 31경기의 문서를 보정하고,
현재 컴파일러에서 이미 차단 0건인 2경기를 재확인해 총 **33경기를 적재 가능 상태로 저장**했다.
나머지 16경기는 확정 근거가 부족하거나 기록 사이의 충돌이 남아 검토 필요 상태를 유지했다.

| 상태                  | 작업 전 | 작업 후 |
| --------------------- | ------: | ------: |
| 검토 필요 문서        |      49 |      16 |
| 소스 수집 실패        |       4 |       4 |
| 화면의 검토 필요 합계 |      53 |      20 |
| 적재 가능             |   4,645 |   4,678 |
| DB 봉인 경기          |       0 |       0 |

확인 시각: 2026-09-13T14:24:38.595Z. DB 가져오기는 수행하지 않았다.

## 보정 기준과 제한

- KBO가 명시한 중계 행만 누락 보완의 근거로 사용했다. 없는 투구·타석 시작·주자 이동은 만들지 않았다.
- 원본 source bundle, 기존 이벤트 ID·소스 위치·원문·관측값을 보존했다. 이전 판정이 수정된 경우에는
  이전 행을 관리용 증거 행으로 남기고, 정정된 사실 행과 KBO URL·행 위치를 추가했다.
- 현재 KBO 공식 기록이 저장된 공식 기록과 달랐던 세 경기의 안타·피안타 수치를 갱신했다.
  2023-04-08 경기는 문자 중계 화면이 오류를 반환하여 공식 경기 리뷰의 이닝별 타격 기록을 사용했다.
- 네 경기의 득점·아웃 순서는 KBO의 송구 경로와 공식 득점·타점 기록을 함께 해석한 보정이다.
  특히 뜬공 뒤 귀루 실패는 일반 포스아웃과 구별했다. 이는 문자 행의 표시 순서를 그대로 복사한 것이
  아니며, 공식 기록과 [KBO 야구규칙 5.09(c)(1)](https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2025_%EC%95%BC%EA%B5%AC%EA%B7%9C%EC%B9%99.pdf)에
  근거한 해석임을 문서 안에 기록했다.
- 2020-08-05 강우콜드 종료는 공식 종료 시각·최종 점수와
  [당일 OSEN 현장 기사](https://osen.co.kr/article/G1111410787)를 대조했다.
- 스트라이크존 측정 5건과 타석 참조가 충돌하는 추적 관측 2건은 이유를 기록하고 명시적으로 제외했다.
  실제 투구와 원본 측정값은 유지했다. 충돌하는 타석 참조를 정정한 것은 아니며,
  현재 구조화 명령으로 해당 참조를 바꿀 수 없어 관측의 제외 상태로 처리했다.
- 소스 원문과 KBO의 모든 비차단 안내 행을 완전히 일치시킨 작업은 아니다. 남은 메타데이터 부족 등
  비차단 경고는 유지했으며, 차단 오류가 없다는 것이 원본 측정값까지 모두 완전하다는 뜻은 아니다.

## 저장한 경기

차단 건수는 연쇄 finding을 포함하며, 독립적인 오류 개수와 다르다. 두 경기는 이미 0건이었으므로
문서 해시를 바꾸지 않고 보관 위치만 승격했다.

| 경기 및 공식 근거                                                                                                                      | 반영 내용                                                                                 | 차단 전 → 후 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -----------: |
| [20200527WONC02020](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20200527WONC0&gyear=2020)            | 9회 마지막 타석·투수 교체·6구·병살타와 주자 아웃 누락 보완                                |        1 → 0 |
| [20200805SSOB02020](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20200805SSOB0&gyear=2020)            | 9회초 강우콜드 종료 선언 보완; 공식 종료 시각 및 당일 현장 기사 대조                      |        1 → 0 |
| [20200907LGLT02020](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20200907LGLT0&gyear=2020)            | 마지막 대타 타석의 5구와 땅볼 결과 보완                                                   |        4 → 0 |
| [20201006HHHT02020](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20201006HHHT0&gyear=2020)            | 상단이 하단보다 낮은 스트라이크존 측정 1건 명시적 제외                                    |        1 → 0 |
| [20210321KTOB02021](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=1&gameId=20210321KTOB0&gyear=2021)            | 마지막 타석 시작·4구·플라이 아웃 보완                                                     |        5 → 0 |
| [20210326LTHT02021](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=1&gameId=20210326LTHT0&gyear=2021)            | 마지막 타석 시작·4구·삼진 보완                                                            |        7 → 0 |
| [20210512WOOB02021](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20210512WOOB0&gyear=2021)            | 마지막 타석 시작·5구·삼진 보완                                                            |        7 → 0 |
| [20210513SKLT02021](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20210513SKLT0&gyear=2021)            | 유효하지 않은 스트라이크존 측정 2건 명시적 제외                                           |        2 → 0 |
| [20210608WOHH02021](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20210608WOHH0&gyear=2021)            | 마지막 타석 시작·2구·땅볼 아웃 보완                                                       |        5 → 0 |
| [20210619SSLT02021](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20210619SSLT0&gyear=2021)            | 현재 컴파일러로 차단 0건 재확인; 문서 변경 없이 승격                                      |        0 → 0 |
| [20220429HHNC02022](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20220429HHNC0&gyear=2022)            | 포스아웃 도착 베이스와 주자별 중계 순서를 실제 송구 경로·공식 2득점에 맞게 교정           |        3 → 0 |
| [20220705NCHH02022](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20220705NCHH0&gyear=2022)            | KBO 현재 박스스코어에 따라 마티니 안타 2·장시환 피안타 1 반영                             |        2 → 0 |
| [20220730LTSS02022](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20220730LTSS0&gyear=2022)            | KBO 현재 박스스코어에 따라 구자욱 안타 2·김유영 피안타 0 반영                             |        2 → 0 |
| [20220730WONC02022](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20220730WONC0&gyear=2022)            | KBO 현재 박스스코어에 따라 김주원 안타 1·최원태 피안타 4 반영                             |        2 → 0 |
| [20220820HHLT02022](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20220820HHLT0&gyear=2022)            | 홈 포스아웃·송구 실책·2득점·마지막 태그아웃의 순서 교정                                   |       11 → 0 |
| [20230314HTHH02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=1&gameId=20230314HTHH0&gyear=2023)            | 이명기 대타·지명타자 및 허관회 포수 교체 시점/역할 교정; 마지막 타석 2구·플라이 아웃 보완 |        7 → 0 |
| [20230408WONC02023](https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx?gameDate=20230408&gameId=20230408WONC0&section=REVIEW) | KBO 경기 리뷰의 손아섭 1회 번트 안타에 따라 야수선택을 안타로 정정                        |        3 → 0 |
| [20230608HHOB02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230608HHOB0&gyear=2023)            | 양석환의 실책 출루 판정을 내야안타로 정정; 이후 실책 진루 보존                            |        2 → 0 |
| [20230616NCHT02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230616NCHT0&gyear=2023)            | 현재 컴파일러로 차단 0건 재확인; 문서 변경 없이 승격                                      |        0 → 0 |
| [20230712OBSK02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230712OBSK0&gyear=2023)            | 박준영의 정정된 2루타 반영; 이전 실책 판정·관측은 증거 행으로 보존                        |        2 → 0 |
| [20230802SKKT02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230802SKKT0&gyear=2023)            | 유효하지 않은 스트라이크존 측정 2건 명시적 제외                                           |        2 → 0 |
| [20230820KTHH02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230820KTHH0&gyear=2023)            | 다른 타석을 참조하는 추적 관측 2건을 provider_conflict로 제외; 실제 투구 보존             |        2 → 0 |
| [20230827LGNC02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230827LGNC0&gyear=2023)            | 뜬공 뒤 귀루 실패를 어필 아웃으로 교정하고 KBO 공식 희생플라이 득점에 맞춰 순서 보정      |       15 → 0 |
| [20230907HTOB02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230907HTOB0&gyear=2023)            | 허경민의 정정된 2루타 반영; 이전 실책 판정·관측은 증거 행으로 보존                        |        2 → 0 |
| [20230913LTHT02023](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20230913LTHT0&gyear=2023)            | 강우콜드 선언 뒤 실제 투구가 없는 투수 교체 안내를 관리 행으로 보존                       |        1 → 0 |
| [20240404LTHH02024](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20240404LTHH0&gyear=2024)            | 재전송·누락 중계 정리; 페라자 홈런과 명시된 두 주자 득점 및 공식 3타점 보완               |       67 → 0 |
| [20240416HHNC02024](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20240416HHNC0&gyear=2024)            | 9회 경기 종료 뒤의 허위 10회 시작·타자 안내를 관리 행으로 보존                            |        1 → 0 |
| [20240504OBLG02024](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20240504OBLG0&gyear=2024)            | 반복 전송 및 누락 투구·타석 시작·아웃을 KBO 행과 대조해 교정                              |       95 → 0 |
| [20240724WOOB02024](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20240724WOOB0&gyear=2024)            | 반복 전송·누락 투구와 주자 이동 보완; 정수빈의 정정된 2루타 반영                          |      183 → 0 |
| [20240828SKHT02024](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20240828SKHT0&gyear=2024)            | 마지막 타석 시작·6구·삼진 보완                                                            |        7 → 0 |
| [20250411SKHT02025](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20250411SKHT0&gyear=2025)            | 뜬공 뒤 귀루 실패를 어필 아웃으로 교정하고 KBO 공식 희생플라이 득점에 맞춰 순서 보정      |        6 → 0 |
| [20250624SKOB02025](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20250624SKOB0&gyear=2025)            | 강우콜드 선언 뒤 실제 진행하지 않은 반이닝·타자·교체 안내를 관리 행으로 보존              |        1 → 0 |
| [20250831NCSK02025](https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20250831NCSK0&gyear=2025)            | 7회초 사구 뒤 KBO에 명시된 두 주자의 진루 행 보완                                         |       16 → 0 |

## 검토 필요 상태를 유지한 경기

| 경기 및 조회 근거                                                                                                                | 차단 | 보류 이유                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [20250920SSLG02025](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20250920SSLG0&gyear=2025) |    3 | KBO에도 1루주자를 상대 팀 투수 원태인으로 표기한다. 명시된 선수 충돌을 추정으로 대체하지 않음.                                                    |
| [20250628HHSK02025](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20250628HHSK0&gyear=2025) |    8 | 첫 타석 시작 행이 두 중계 모두에 없다. 투구로부터 타석 시작을 합성하지 않음.                                                                      |
| [20230818LGSK02023](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20230818LGSK0&gyear=2023) |    2 | 투수별 실점 귀속이 공식 기록과 다르다. 중계는 기존 원장과 같아 책임 주자 계산·기록 판정을 추가 확인해야 함.                                       |
| [77771104SKWO02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=7&gameId=20221104SKWO0&gyear=2022) |    1 | 김재웅의 중계 투구는 22개, 공식 투구 수는 21개다. 어느 투구를 제외할지 확인되지 않음.                                                             |
| [20221005LGHT02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20221005LGHT0&gyear=2022) |    2 | 파노니·장현식의 실점 귀속 불일치. 동일 중계만으로 책임 주자 귀속을 정정할 수 없음.                                                                |
| [20220922HHSK02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20220922HHSK0&gyear=2022) |    1 | 김민우의 중계 투구는 106개, 공식 투구 수는 105개다. 제외할 투구를 특정하지 못함.                                                                  |
| [99990716WEEA02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=9&gameId=20220716WEEA0&gyear=2022) |   18 | 올스타전 승부치기 결과 요약만 있고 필요한 10회 개별 중계가 없다. 별도 경기 규칙·실제 타석 근거가 필요함.                                          |
| [20220529SSLG02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20220529SSLG0&gyear=2022) |    2 | 진해수·정우영의 실점 귀속 불일치. 동일 중계만으로 책임 주자 귀속을 정정할 수 없음.                                                                |
| [20220510KTHT02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20220510KTHT0&gyear=2022) |   10 | 끝내기 안타에서 1·2루 주자의 이동 행이 두 중계 모두에 없다. 타석 결과만으로 기존 주자의 이동을 합성하지 않음.                                     |
| [20220429OBSK02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20220429OBSK0&gyear=2022) |    1 | 10회말 최상민의 2구 타격과 원천 볼카운트가 모순된다. KBO 문자만으로 누락 투구인지 관측 오류인지 확정하지 못함.                                    |
| [20220315HHLT02022](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=1&gameId=20220315HHLT0&gyear=2022) |   38 | 중계의 주자 김민수 표기와 실제 원장의 주자 위치가 충돌한다. KBO에도 같은 표기가 있어 확정 근거가 부족함.                                          |
| [20211030LGLT02021](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20211030LGLT0&gyear=2021) |   51 | 정훈 대타·배성근 자동 고의4구·정훈에서 배성근으로 대주자 교체가 서로 충돌한다. 공식 볼넷도 배성근에게 귀속되어 교체 역할·시점을 추가 확인해야 함. |
| [20200822LTSS02020](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20200822LTSS0&gyear=2020) |    1 | 강민호의 첫 투구는 문자상 볼, 관측과 후속 카운트는 스트라이크다. KBO에도 같은 문자여서 판정 충돌을 해소하지 못함.                                 |
| [20200510HTSS02020](https://www.koreabaseball.com/Game/LiveTextView2.aspx?leagueId=1&seriesId=0&gameId=20200510HTSS0&gyear=2020) |   11 | 볼넷 뒤 기존 1루주자의 이동 행이 두 중계 모두에 없다. 자동 진루를 새 원장 행으로 합성하지 않음.                                                   |
| 66660427NCHT02020                                                                                                                |    2 | 연습경기의 KBO 공식 문자 중계를 확인하지 못함. 투수 실점 귀속 불일치 유지.                                                                        |
| 66660421SSHT02020                                                                                                                |    1 | 연습경기의 KBO 공식 문자 중계를 확인하지 못함. 마지막 반이닝 종료 근거 부족.                                                                      |

별도의 소스 수집 실패 4건은 2023-09-01의 한화–LG, KIA–SSG, KT–키움, NC–삼성 경기다.
이들은 교정할 정상 경기 문서가 없어 이번 문서 보정에 포함하지 않았다.

## 적용 및 검증

- 실행 중인 서버의 correction session API로 미리보기 → atomic batch → 전체 strict compile →
  version/base hash 확인 → 차단 없는 commit 순서로 저장했다. 파일 writer lock을 우회하지 않았다.
- 명령을 적용한 31경기의 미리보기 결과와 실제 적용 문서 해시가 일치했다. 저장한 33경기를 별도 세션으로 다시 열어 저장 해시와
  차단 0건을 재확인했다. 미수정 16경기도 다시 열어 문서·해시·차단 건수가 이전과 같음을 확인했다.
- 전체 대상 49경기의 소스 bundle과 각 endpoint의 hash를 공개 읽기 API로 검증했다. 기존 원본 파일도
  읽어 같은 source bundle을 참조하는지 확인했다. 모든 기존 이벤트의 identity·원문·관측 및 추적
  원시 측정 필드가 보존됐고, 로스터·팀·경기 메타데이터도 바뀌지 않았다.
- 최초 4,698개 current manifest의 SHA-256과 작업 후 파일을 비교했다. 변경은 승인된 33경기에만
  한정됐으며, 다른 4,665개와 전체 manifest 개수는 동일했다.
- 저장한 33경기에 비차단 경고가 남아 있다: 제공자 구속 메타데이터 오류 923건, 투구 추적 관측 누락
  64건, 추적 순번 차이 4건, 공식 타점 검증 불가 3건. 유효하지 않은 관측을 지어내 채우지 않았다.
- 이번 작업은 운영 문서 보정이며 컴파일러·수집기·교정 명령의 구현 코드는 변경하지 않았다.
- 저장소 기본 품질 게이트도 통과했다: lint, format:check, typecheck, test, schema:game:check, build.
  테스트는 699개 통과, PostgreSQL DSN이 없는 통합 테스트 44개는 skip됐다. DB 동작 변경이나 적재는
  없었으므로 별도의 DB 통합·Compose E2E 검증은 실행하지 않았다.

적용 전 세션, KBO 조회 원문, 경기별 명령, 미리보기 결과, 전후 해시와 재검증 결과는 로컬의
`test-results/kbo-review-20260913/`에 보관했다. 이 경로는 Git 제외 대상이며 사용자 데이터와 함께
별도로 관리해야 한다. 각 수정 문서에도 근거 URL과 보정 설명을 남겼다.
