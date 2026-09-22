# 구장별 무브먼트 편향 연구

2020–2025 수집 자료의 구장 편향·좌표 기준·자동 보정 후보를 비교한 오프라인 연구다.
서비스 구현의 현재 계약은 [분석 문서](../../docs/analysis/README.md)와
[투구 움직임 정의](../../docs/pitch-shape-analysis.md)를 따른다.

읽을 보고서는 `report.md`, `automatic-calibration.md`, `calibration-search.md`,
`calibration-performance.md`와 같은 이름의 HTML이다. CSV 요약·그림과 생성 스크립트를 함께 보관한다.

대용량 입력·압축 추출 자료·pickle·계수 checkpoint·개별 검증 입력과 Python bytecode는 Git에서
제외한다. 로컬 파일은 보존하며 원천 DB·보정 계수·운영 모델을 저장소에 복제하지 않는다.
재현하려면 동일한 봉인 자료를 갖춘 로컬 환경에서 `extract.py`와 해당 보고서 생성 스크립트를
실행해야 한다. 실행마다 원천 revision/hash와 기간을 확인하며 다른 자료의 결과를 같은 실행으로
간주하지 않는다. 스크립트의 로컬 Docker 경로·Python 라이브러리 설정을 먼저 확인한다.

실제 서비스의 반복 검증은 저장 fixture를 사용하는 테스트와 `pnpm analysis:validate`,
`pnpm analysis:audit`를 사용한다. 이 연구 스크립트는 운영 서버의 요청 처리 경로에 포함되지 않는다.
