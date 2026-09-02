# ADR 0001: 로컬 웹 모듈러 모놀리스와 Docker Compose

- 상태: 승인
- 날짜: 2026-08-20

## 배경

KBO Workbench는 Naver 경기 수집, 구조화 보정, PostgreSQL 적재와 DB 기반 replay를 제공한다.
기존 구현은 Python CLI와 PySide6 GUI였지만 새 제품은 기존 코드 호환 없이 웹 UI를 유일한
사용자 인터페이스로 사용한다.

제품은 현재 단일 사용자가 로컬에서 운용한다. reducer, validation과 revision transaction은
같은 경기 입력에 대해 하나의 원자적 정합성 경계를 가져야 한다. 반면 웹 정적 파일,
애플리케이션 API와 PostgreSQL의 실행 환경은 서로 격리할 필요가 있다.

## 결정

1. 새 제품은 TypeScript로 작성한다.
2. React/Vite 웹과 Fastify API를 분리한다.
3. collection, correction, persistence와 replay는 API 안의 package 경계로 유지한다.
4. 배포는 `web`, `api`, `db` 장기 실행 컨테이너와 `migrate` one-shot container로 구성한다.
5. 브라우저에는 `web`의 localhost port 하나만 공개한다.
6. API와 DB는 Docker network 내부에서만 접근한다.
7. 애플리케이션 기능 CLI는 제공하지 않는다.
8. `docker compose up -d` 등 Compose 명령은 운영 인터페이스로 유지한다.

## 이유

- 웹과 API 계약을 분리하면서도 분산 transaction을 만들지 않는다.
- Node, Chromium과 PostgreSQL을 host에 직접 설치하지 않아도 된다.
- Playwright 수집과 React E2E를 같은 생태계에서 운영할 수 있다.
- DB revision commit의 원자성을 한 API process와 PostgreSQL transaction 안에서 유지한다.
- 나중에 필요할 때 collection worker 같은 명확한 병목만 별도 process로 추출할 수 있다.

## 결과

### 장점

- 동일한 Compose 파일로 개발·검증 가능한 실행 환경을 제공한다.
- web reverse proxy 덕분에 browser API 요청에 CORS가 필요 없다.
- domain package는 Fastify, React, PostgreSQL과 Playwright로부터 독립적이다.
- 사용자 workflow는 모두 웹 화면에서 수행한다.

### 비용

- Docker Desktop 실행 비용과 image build 시간이 필요하다.
- Playwright를 포함한 API image가 크다.
- 컨테이너 시작·중지와 backup은 별도 운영 문서가 필요하다.

## 후속 규칙

- 컨테이너 수를 도메인 모듈 수에 맞춰 늘리지 않는다.
- DB 쓰기는 persistence module을 통해서만 수행한다.
- API response와 external input은 runtime JSON Schema로 검증한다.
- 새 배포 단위를 만들려면 독립 scale, 장애 격리 또는 배포 필요성을 먼저 증명한다.

## 코드 계층과 공개 façade

```text
Naver adapter → 평면 수집 원장 → game-core compiler → typed PostgreSQL → replay/analysis
                     ↑                    ↑
                  correction          단일 규칙 정본
```

- package 간 참조는 `@kbo/<package>` 공개 root만 사용하고 deep import하지 않는다.
- package root는 명시적인 named export만 노출한다. 내부 파일 추가가 곧 공개 API 확대가 되지 않는다.
- `collection`은 provider 해독·한국어 lexical 규칙과 원장 방출을 소유한다.
- `game-core`는 provider 타입·이름·한국어 lexical 정규식을 알지 못하며 원장 사실만 compile한다.
- `persistence`는 projection descriptor를 쓰기·읽기·hash의 공통 컬럼 정본으로 사용한다.
- Fastify composition root는 오류 변환과 공통 hook만 소유하고 route는 system/catalog, collection,
  correction, import, replay plugin으로 나눈다.
- 보정 화면은 session controller, timeline/finding/detail, drawer, player picker와 kind별 editor
  registry로 나눈다. editor registry가 폼 변환·기본값·검증·원장 command 입력을 소유한다.

이 경계는 architecture test로 검사한다. 특정 경기 ID나 fixture 위치에 따른 production 분기, 다른
package의 deep import, `game-core`의 provider/한국어 lexical 지식 유입은 허용하지 않는다.
