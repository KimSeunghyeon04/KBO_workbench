# 분석 UI 운영 배포

2026-09-24, 대상은 로컬 운영 서비스 `http://127.0.0.1:8080`이다.
[분석 화면 해석 개선](2026-09-24-analysis-comprehension-improvements.md)의 웹·API를 같은 소스로 빌드했다.

## 배포 대상과 사전 확인

- 소스는 `4b81ee3b9baa9385e987e9efecc766863d577bde` 위의 검증된 미커밋 변경을 포함한다. 배포 입력 560개 파일의 SHA-256 목록을 별도 증거에 저장했다.
- 배포 전 API/web/DB가 healthy이며 PostgreSQL 16, 실제·기대 migration 모두 `0012_competition_game_links`임을 확인했다. 이번 배포에는 migration 추가가 없다.
- 수집·적재·모델 갱신·기록정정의 대기/실행/취소 중 작업은 모두 0건이었다. 자료 품질 준비 작업과 미저장 교정 세션은 안전한 전체 조회 API가 없어 개수를 확인하지 않았다.
- API의 기존 이미지 `sha256:000200d9dff9fb661bfee8c36f694d88c7f3662d5ed86ca9ff18f534c29ad52d`를 복구용 태그로 보존했다. 기존 웹의 Docker 이미지 레이어가 남아 있지 않아 태그·commit으로 보존할 수 없었으므로 실행 중 컨테이너의 정적 파일과 nginx 설정을 별도로 복사했다.
- 배포 전 현재 경기 4,697개, 봉인 revision 4,814개와 current/active 파일 3개의 집합 해시를 기록했다.

새 이미지:

| 서비스 | 이미지 ID                                                                 |
| ------ | ------------------------------------------------------------------------- |
| API    | `sha256:16af2e76fcc2f447d56cb1be47b980dde8cd0ed21034a45d7c4dad91003dd9f7` |
| 웹     | `sha256:a15e01ed333f9a1419ececfefa0a52fddb6ee14cbb2289f1125a320f6d8ccd03` |

Docker 빌드에서 서버와 웹의 타입 검사·production build를 다시 수행했다. 변경 코드의 전체 품질 게이트와 1,218개 회귀 테스트는 개선 문서에 기록되어 있다.

## 백업·교체·검증

기존 백업 스크립트로 writer를 중지하고 `.backups/kbo-workbench-20260924T102842791Z`에 DB dump와 전체 workspace ZIP을 생성했다. manifest의 app 3.1.1, migration 0012, DB 계약 4/4/1/2를 확인하고 두 파일을 다시 해시 검증했다.

| 백업          | 크기(bytes) | SHA-256                                                            |
| ------------- | ----------: | ------------------------------------------------------------------ |
| postgres.dump | 358,325,366 | `68d0088abf259883ef1a7e7b24a3db9cc4ccce91e497fed3e5b6b82b93ffbeec` |
| workspace.zip | 888,506,623 | `174868fd69e6935b4942d2c0d1c0e15f54778883c073ec1c2915c0b24cf59d58` |

백업 스크립트의 재시작 과정에서 기존 migrate 서비스의 계약 확인이 성공했다. 이후 `docker compose up -d --no-deps --no-build --force-recreate --timeout 60 --wait --wait-timeout 300 api web`으로 API와 웹만 교체했다. PostgreSQL 컨테이너를 재생성하거나 volume을 교체하는 명령은 실행하지 않았다.

API/web의 실행 이미지 ID가 빌드 결과와 일치하고 모두 healthy이며, DB 컨테이너 ID와 volume이 그대로인 것을 확인했다. 배포 전후 다음 값도 모두 일치했다.

- 현재 경기 4,697개와 현재 revision 집합 해시
- 봉인 revision 4,814개의 ID·revision·document hash·projection hash 집합 해시
- current/active 파일 3개의 경로·내용 해시

### 운영 HTTP·브라우저 검증

운영 8080 포트에서 GET 12개가 모두 성공했다. 응답을 최신 TypeBox 스키마로 검증하고 다음 조건을 확인했다.

- live/ready/system 정상, DB healthy
- 김도영 2025·2024 타격 기록과 손주영 2025 투구 기록이 요청한 `playerId`를 유지하고 해당 선수 한 행만 반환
- 손주영의 첫 공 직구·두 번째 2스트라이크 배합 327쌍, 조합별 평균과 유효 표본 수 일치. 직구→커브는 111쌍 중 도착 코스 계산 104쌍
- 최근 변화 3경기 대 이전 5경기, 타자 반응·선구안의 2스트라이크 조건, 구질·모델 미준비 응답 정상

실제 운영 브라우저에서는 최근 변화의 사용률 %p·신뢰구간·소표본 카드, 손주영 기본 기록(30경기·153이닝·ERA 3.41), 배합 평균별 유효 표본, 김도영 반응→선구안의 2스트라이크 전달을 확인했다. 시즌을 2024로 바꾼 뒤에도 김도영(ID 52605)과 해당 조건이 유지되고 분석 완료 화면이 표시됐다.

준비 완료 후 확인한 구간의 API warning/error와 HTTP 5xx는 각각 0건이며, 검증 탭의 alert·console warning/error도 없었다. GET 검사의 선구안 첫 조회는 21.083초가 걸렸다. 다른 분석 GET은 이 표본에서 33–1,193ms였으며, 이는 부하 시험이나 모든 선수·시즌의 성능 보장은 아니다.

배포 과정에서 원장 교정, 경기 재수집·재적재, 모델 재학습은 수행하지 않았다. 기존 통계 미리보기 컨테이너는 변경하지 않았고, 이번 검증은 운영 8080에 직접 연결했다. 검증용 브라우저 탭은 닫았다.

원 실행 증거는 Git에 포함하지 않는 `analysis/deployment/20260924-analysis-ui-production/`에 보관한다. 비밀 환경값은 기록하지 않는다.
