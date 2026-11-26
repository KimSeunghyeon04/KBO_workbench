---
name: KBO Workbench
description: 미니멀리즘·플랫 디자인으로 기록과 분석 근거를 읽는 로컬 작업 공간
colors:
  ui-accent: "#14694f"
  action: "#176b45"
  action-hover: "#125738"
  ui-selected: "#eaf3ef"
  ui-surface: "#ffffff"
  ui-surface-subtle: "#f5f7f6"
  ui-ink: "#182b25"
  ui-muted: "#52655d"
  ui-line: "#dce4df"
  secondary-ink: "#4e5952"
  ui-danger: "#a33b32"
  ui-warning: "#8c591f"
typography:
  headline:
    fontFamily: "Pretendard, Noto Sans KR, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.03em"
  title:
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Pretendard, Noto Sans KR, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontSize: "12px"
    lineHeight: 1.6
  control:
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.6
  field:
    fontSize: "13px"
    lineHeight: 1.6
  navigation-active:
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.6
  metric:
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.6
rounded:
  control: "4px"
  status: "999px"
spacing:
  compact: "4px"
  small: "8px"
  control-gap: "12px"
  group: "16px"
  medium: "20px"
  panel: "24px"
  section: "28px"
  wide: "32px"
  page-bottom-small: "48px"
  page-bottom: "64px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.ui-surface}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.ui-surface}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "30px"
  analysis-field:
    backgroundColor: "{colors.ui-surface}"
    textColor: "{colors.ui-ink}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
    height: "40px"
  navigation-active:
    backgroundColor: "{colors.ui-selected}"
    textColor: "{colors.ui-accent}"
    typography: "{typography.navigation-active}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  player-role:
    backgroundColor: "{colors.ui-surface-subtle}"
    textColor: "{colors.ui-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "3px 7px"
  panel:
    backgroundColor: "{colors.ui-surface}"
    rounded: "{rounded.control}"
    padding: "24px"
  record-metric:
    textColor: "{colors.ui-ink}"
    typography: "{typography.metric}"
---

# Design System: KBO Workbench

## Overview

**Creative North Star: "정돈된 기록 작업 공간"**

사용자가 지정한 미니멀리즘·플랫 디자인을 유지한다. 흰 본문, 옅은 회색 탐색 영역,
절제된 녹색 선택과 행동, 선명한 제목·수치, 그룹 사이 여백으로 위계를 만든다.
관리와 분석은 같은 시각 언어를 공유하되 원장·표·차트에 필요한 밀도는 각 표시 모듈이 소유한다.

이 문서는 2026-09-25 구현을 읽어 기존 DESIGN.md를 갱신한 **사후 scan 문서**다.
아래 방향 블록은 사용자 고정 방향과 현재 코드의 관계를 기록하며, 구현 전 승인이나
독립 finish review 통과를 증명하지 않는다. 대안 comp 비교, 무작위 방향·seed 탐색,
사전 5블록·QUALITY BAR 승인 과정은 이 작업에서 실행·기록되지 않았다.
현재 구현을 그 과정이 있었던 것처럼 재해석하거나 방향을 다시 무작위화하지 않는다.
품질 판정과 브라우저 증거는 [재설계 검토 기록](docs/reviews/2026-09-25-full-ui-redesign.md)이 소유한다.

**QUALITY BAR — 사후 정리:** 제목·선택 범위·현재 상태·다음 동작이 구분되어야 하고,
데스크톱과 좁은 화면에서 핵심 수치·단위·분모·근거가 보존되어야 한다. 키보드 포커스,
표 내부 스크롤, 모바일 메뉴, 로딩·빈 상태·오류를 실제 렌더링에서 점검한다.
통과 여부는 유효한 캡처와 동작 검증으로 별도 판정한다.

### THESIS

기록을 읽고 다음 작업으로 이동하는 데 필요한 위계를 여백·글자 크기·얇은 경계로 만든다.
시각적 단순함을 위해 데이터의 불확실성이나 교정 단계의 의미를 지우지 않는다.

### OWN-WORLD

흰 작업면과 회녹색 탐색면, 짙은 녹색 잉크, 작은 반경의 평탄한 컨트롤이 현재 구현의 재료다.
사진·히어로 연출·장식 그라데이션을 추가하지 않는다. 분석 범례의 연속 색상과
필드·스트라이크존의 도형은 데이터를 표현하는 용도로 구분한다.

### STORY

현재 구현은 수집 → 검토·보정 → 저장 → 선수 분석·경기 재생으로 이어진다.
관리 화면은 상태와 다음 작업, 분석 화면은 선수·조회 범위와 핵심 관측을 앞에 둔다.
상세 표·정의·revision 근거는 의미 있는 후속 읽기 위치에 남긴다.

### FIRST VIEWPORT

관리 화면의 제목·작업 대상·주 행동, 선수 화면의 선수 이름·범위·분석 항목을 먼저 읽게 한다.
필터가 긴 화면은 핵심 차트를 그 다음에 배치한다. 모든 분석 차트가 모든 높이에서 첫 화면에
완전히 들어온다고 주장하지 않는다. 모바일에서는 상단바가 선수 이름을 가리지 않는지 확인한다.

### FORM

고정 탐색 열과 유동 본문, 행 단위 상태·요약, 질문에 맞는 차트, 필요한 정확한 표를 함께 쓴다.
모든 정보를 같은 크기의 카드로 바꾸지 않는다. 재생 점수판은 짙은 잉크 단색 면이며,
플레이 제어는 16px 인라인 SVG와 접근 가능한 버튼 이름을 사용한다.

**Key Characteristics:**

- 미니멀리즘·플랫 디자인과 작업 밀도의 공존.
- 선수·범위·관측·비교·근거가 이어지는 읽기 순서.
- 선택 상태와 주 행동에 제한한 녹색 강조.
- 단위·분모·null·소표본·revision 근거를 보존하는 표시.

## Colors

흰색과 회녹색 중립면 위에 짙은 녹색을 사용한다. 프런트매터는 확인한 값의 정본이며,
런타임 공통 색상은 [design-tokens.css](apps/web/src/styles/design-tokens.css)가 소유한다.

사이드카의 8단계 tonal ramp는 패널 미리보기를 위해 색상에서 합성한 참고 띠다.
실제 앱의 추가 색상 토큰이나 차트 범례로 채택한 값이 아니다.

### Primary

- **선택 녹색** (`ui-accent`): 탐색 선택, 포커스, 분석 막대와 주요 링크.
- **실행 녹색** (`action`, `action-hover`): 기존 공통 실행 버튼과 그 hover.
  선택 녹색과 실제 값이 다르므로 하나의 값으로 문서상 합치지 않는다.
- **선택 면** (`ui-selected`): 현재 탐색 항목과 선택 컨트롤의 옅은 배경.

### Neutral

- **작업면** (`ui-surface`): 본문과 패널.
- **보조면** (`ui-surface-subtle`): 사이드바·표 머리·선수 역할 태그.
- **잉크** (`ui-ink`): 기본 텍스트와 재생 점수판의 단색 배경.
- **보조 잉크** (`ui-muted`): 설명·범위·표본 레이블.
- **구분선** (`ui-line`): 공통 패널·행·그룹 경계.
- **보조 버튼 잉크** (`secondary-ink`): 기존 공통 보조 버튼.

위험·주의 토큰은 `ui-danger`와 `ui-warning`이다. 기존 상태별 컴포넌트에는 별도 의미색이
남아 있어 모든 상태가 이 두 토큰으로 통일되었다고 간주하지 않는다. 텍스트·레이블·형태를
함께 사용한다. 히트맵과 궤적의 색상은 해당 분석의 범례·좌표 계약을 따른다.

**The Meaningful Color Rule.** 색은 선택·상태·데이터를 설명하며 텍스트와 분모를 대신하지 않는다.

## Typography

**Body Font:** Pretendard → Noto Sans KR → system-ui → -apple-system →
BlinkMacSystemFont → sans-serif. 이는 선언된 fallback 순서이며 폰트 설치·다운로드를
보장하지 않는다. 이번 문서화에서 새 글꼴이나 의존성을 추가하지 않았다.

별도 장식용 display face는 없다. 작업 제목도 같은 한글 sans 계열을 사용한다.
점수·일부 원시 식별자는 기존 SFMono-Regular / Consolas / monospace를 사용한다.

- **Headline:** 일반 화면 제목. 선수 리포트 내부 화면 제목은 22px로 낮춰 선수 이름과 구분한다.
- **Title:** 분석 패널 제목. 공통 관리 섹션의 자간은 -0.015em, 분석 패널은 프런트매터의 값이다.
- **Body / Label:** 작업 본문과 보조 설명. 일부 분석 문단은 13px·줄높이 1.75,
  캡션은 12px·줄높이 1.8을 사용한다.
- **Metric:** 선수 이름은 30px·줄높이 1.3,
  640px 이하에서는 25px다. 대시보드 수치는 30px·줄높이 1이다.
- **Control / Field:** 기존 공통 버튼과 분석 입력의 별도 밀도 역할이다.

숫자 요약과 표에는 `tabular-nums`를 사용한다. 일반 화면 설명은 최대 75ch다.
원시 ID는 줄바꿈 가능한 근거 영역에 남긴다. 좁은 화면을 이유로 주요 수치를 작은 보조 글자로
일괄 축소하지 않는다.

**The Numerical Alignment Rule.** 비교 수치는 같은 열·단위·숫자 폭으로 읽을 수 있게 배치한다.

## Layout

[foundation-layout.css](apps/web/src/styles/foundation-layout.css)와
[responsive.css](apps/web/src/styles/responsive.css)가 공통 구조를 소유한다.

- 데스크톱 상단바는 56px, 탐색 열은 208px다. 본문은 `minmax(0, 1fr)`이며
  최대 폭 1240px, 좁은 설정형 페이지는 960px다.
- 일반 본문 패딩은 위 36px, 좌우 `clamp(24px, 4vw, 56px)`, 아래 64px다.
  페이지 섹션 간격은 28px, 공통 패널 내부는 24px다. 모든 간격을 4px 배수로만 강제하지 않는다.
- 860px 이하에서는 탐색 열을 접고 메뉴 버튼으로 연다. 열린 메뉴는 두 열로 표시하며
  Escape로 닫으면 메뉴 버튼으로 포커스가 돌아간다.
- 620px 이하 관리 본문은 `22px 16px 48px`다. 600px 이하 상단바는 96px이며
  열린 메뉴는 그 아래에서 시작한다.
- 640px 이하 분석 본문은 `16px 12px 40px`, 섹션 간격은 12px다.
  선수 분석 탭은 한 줄에서 가로로 스크롤하고, 기본 기록 표는 연도 열을 고정한다.
- 재생은 1280px 이하에서 보조 패널을 재배치하고 860px 이하에서 한 열이 된다.
  620px 이하 재생 컨트롤은 다섯 버튼 행·속도·장면 위치·scrubber를 나눠 배치한다.
- 표는 자체 가로 스크롤을 허용한다. 페이지 전체의 가로 넘침으로 긴 표를 처리하지 않는다.
  행 선택·편집의 기준은 canonical 원장 순서이며 DOM에 보이는 행 순서로 바꾸지 않는다.

다른 경로로 이동할 때는 문서 맨 위로 이동하고 같은 경로의 필터 변경은 스크롤을 유지한다.
이 동작은 [탐색 접근성 테스트](tests/web/ui-navigation-accessibility.test.ts)에 고정되어 있다.

## Elevation & Depth

공통 패널과 분석 표면은 그림자 없이 옅은 면·1px 경계·여백으로 구분한다.
점수판은 단색 잉크 면이며 장식 원·그라데이션이 없다. 데이터 수치에 연결된 히트맵 범례와
궤적 시간 범례의 연속 색상은 장식 그라데이션 금지의 대상이 아니다.

**The Flat Surface Rule.** 공통 작업면의 구분은 여백·구분선·명도 차로 만든다.

**비정형 잔존 표현:** 재생 경기 선택 팝오버, 일부 필드 선수·상태 표식에는 기존 그림자와
glow 선언이 남아 있다. 공통 elevation token으로 승인하거나 다른 화면으로 전파하지 않는다.
이 문서화 범위는 해당 코드를 수정하지 않았으며, 실제 시각 영향과 수정 판정은 검토 기록에 남긴다.

공통 컨트롤은 장식 이동 애니메이션을 요구하지 않는다. `prefers-reduced-motion: reduce`에서
animation·transition은 0.01ms, scroll behavior는 auto로 제한한다.

## Shapes

공통 컨트롤·패널은 작은 반경과 1px 경계를 사용한다. 상태 배지의 pill 형태는 기존 의미 표현이며,
모든 버튼·필터를 pill로 바꾸는 근거가 아니다. 분석용 홈플레이트·스트라이크존·베이스 도형은
데이터를 설명하는 기하 구조로 유지한다.

키보드 기본 포커스는 선택 녹색의 2px outline과 3px offset이다.
일부 기존 폼은 별도 focus 테두리와 가까운 outline을 가지므로 새 화면은 공통 동작을 우선 따른다.
작은 반경 차이와 기존 국소 색상은 전체 통일이 완료된 증거로 해석하지 않는다.

## Components

### Buttons

실행 버튼은 단색 실행 녹색, 보조 버튼은 흰색·얇은 테두리다. 기본 실행 높이는 36px,
기본 보조 높이는 30px이며 화면별 toolbar가 밀도를 조절한다. hover는 면색 변화다.
disabled는 기본 공통 버튼에서 opacity 0.55와 기본 커서를 사용하고 실제 disabled 의미를 유지한다.
분석 버튼은 13px·8px 12px 패딩의 별도 표현이며 눌림 상태를 `aria-pressed`로 제공한다.

### Chips

선수 역할은 작은 사각 태그다. 상태 배지는 작은 점과 텍스트를 함께 둔다.
선택 필터는 색뿐 아니라 눌림 상태를 표시한다. 태그를 장식용 머리말로 새로 늘리지 않는다.

### Cards / Containers

공통 패널은 흰 면·얇은 경계·작은 반경이다. 대시보드 수치, 기본 기록, 설정 진단은
개별 카드 반복 대신 행과 구분선으로 묶는다. 패널 안의 상세 패널을 반복해서 둘러싸지 않는다.
`WorkflowGuide`는 제목·설명·세 단계 목록을 사용하며 640px 이하에서 한 열로 접힌다.

### Inputs / Fields

레이블이 있는 분석 입력은 40px 높이, 13px 글자, 7px 10px 패딩이다.
기존 수집 폼의 36px 입력과 구분하여 기록한다. 고급 조건은 펼침 영역에 두고 선택 범위는
화면에서 확인할 수 있게 한다. 잘못된 값·조회 실패·빈 결과는 서로 다른 설명과 후속 행동을 제공한다.

### Navigation

상단에서 데이터 관리/분석을 전환하고 영역별 마지막 URL을 복원한다. 사이드바는 의미 있는
그룹, 선수 리포트는 이름·범위와 검색·시즌 선택 아래 분석 탭으로 나뉜다. 현재 경로는 `aria-current`,
모바일 메뉴는 `aria-expanded`로 표시한다. 메뉴 선택 후 본문, Escape 후 메뉴 버튼으로
포커스를 이동한다. 본문 바로가기 링크를 유지한다.

### Analysis summaries and evidence

표시 모듈은 기존 응답의 형식·배치·선택을 담당한다. 막대 길이와 소수점·퍼센트·이닝 표시는
화면 표현이며 새 야구 통계나 사실을 산출하는 경로가 아니다.

| 소유 모듈                                                                            | 표시 책임                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [player-analysis-frame.tsx](apps/web/src/analysis/player-analysis-frame.tsx)         | 선수 identity·범위·분석 항목 탐색                       |
| [player-season-records.tsx](apps/web/src/analysis/player-season-records.tsx)         | 연도별 타격·투구 합계와 미확정 ERA 표시                 |
| [pitch-location-panel.tsx](apps/web/src/analysis/pitch-location-panel.tsx)           | 포수 시점 코스 지도·선택 영역·소표본 표현               |
| [pitch-sequence-groups.tsx](apps/web/src/analysis/pitch-sequence-groups.tsx)         | 상위 6개 조합 막대·전체 조합 선택                       |
| [pitch-sequence-pairs.tsx](apps/web/src/analysis/pitch-sequence-pairs.tsx)           | 선택한 두 공·페이지·근거 연결                           |
| [matchup-observed-summary.tsx](apps/web/src/analysis/matchup-observed-summary.tsx)   | 직접/유사 표본을 공통 0–100% 축으로 비교                |
| [park-rate-chart.tsx](apps/web/src/analysis/park-rate-chart.tsx)                     | 서버가 제공한 구장 관측 비율의 지표 전환·공통 0 기준 축 |
| [baserunning-opportunities.tsx](apps/web/src/analysis/baserunning-opportunities.tsx) | 기회 결과·미상·분모·정확한 revision의 주루 장면         |

차트 다음에는 수치 표·정의·개별 근거를 유지한다. 관측과 예측, null과 0, 소표본과 확실성을
구별한다. 브라우저는 원장·컴파일러·sealed DB의 권위를 대체하지 않는다.

### Replay

경기·revision 선택 뒤 점수와 현재 장면을 표시하고 필드·궤적·중계·재생 제어를 연결한다.
점수판의 이닝과 재생 속도는 한 줄로 유지한다. 재생 아이콘은
[playback-icon.tsx](apps/web/src/replay/playback-icon.tsx)의 16px 인라인 SVG다.
버튼의 접근 가능한 이름을 유지하며 아이콘 자체는 보조 기술에서 숨긴다.
현재 표시 상태와 장면 이동은 검증된 replay 응답에만 의존한다.

## Do's and Don'ts

### Do:

- **Do** 선택된 선수·조회 범위·표본을 결과와 가까이 둔다.
- **Do** 실제 값·단위·분자·분모·미상 상태와 revision 근거를 유지한다.
- **Do** 공통 토큰과 기존 컨트롤을 재사용하고 차트의 좌표·범례 계약을 보존한다.
- **Do** 데스크톱·모바일 실제 렌더링에서 포커스·넘침·조건 전환·근거 이동을 확인한다.

### Don't:

- **Don't** 장식 사진·히어로·그라데이션·그림자를 공통 작업면의 새 규칙으로 추가한다.
- **Don't** 모든 정보를 같은 카드나 같은 표로 바꾸거나 중요한 분모를 숨긴다.
- **Don't** 글자 아이콘·장식 머리말·새 display face를 이 구현의 공통 규칙으로 만든다.
- **Don't** 문서의 사후 방향 정리를 사전 사용자 승인이나 독립 검토 통과 증거로 제시한다.
