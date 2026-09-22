"""Build a Korean research report and standalone figures from saved results."""

import base64
import html
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import markdown
import numpy as np
import pandas as pd

from calibration_search import DEST, OUT, SCALE, dump_json, save

plt.rcParams.update({"font.family":"Malgun Gothic","axes.unicode_minus":False,
                     "font.size":10,"axes.spines.top":False,"axes.spines.right":False})


def md_table(headers, rows):
    return "| "+" | ".join(headers)+" |\n| "+" | ".join(["---"]*len(headers))+" |\n"+"\n".join(
        "| "+" | ".join(str(v) for v in row)+" |" for row in rows)


def label(model, configurations):
    if model=="uncorrected": return "보정 없음"
    if model=="last_month": return "지난달 계수"
    if model=="season_to_date": return "시즌 누적 추정"
    c=configurations[model]
    family=c["family"]
    if family=="direct":
        prefix={"monthly":"월별","weekly":"주별","daily":"일별","fortnightly":"격주"}[c["frequency"]]
        half=f"반감기 {c['half']:g}일" if c["half"] else "동일 가중"
        return f"{prefix}·{c['window']}일·{half}"+("·Huber" if c["robust"] else "")
    if family=="ewma": return f"월계수 {c['window']}개월·반감기 {c['half']:g}개월"
    if family=="ema": return f"재귀 평활화 α={c['alpha']:g}"
    if family=="precision": return f"월계수 신뢰도 가중 h={c['half']:g}, q={c['drift']:g}"
    if family=="kalman": return ("적응형 칼만" if c["adaptive"] else "칼만")+f" q={c['drift']:g}"
    if family=="trend": return f"최근 추세 연장 {c['damp']:g}배"
    return model


def main():
    selection=json.loads((DEST/"selection.json").read_text(encoding="utf-8"))
    protocol=json.loads((DEST/"protocol.json").read_text(encoding="utf-8"))
    verification=json.loads((DEST/"verification.json").read_text(encoding="utf-8"))
    configs={c["id"]:c for c in protocol["grid"]}
    chosen=selection["selected"]
    config=configs[chosen]
    leaders=pd.read_csv(DEST/"leaderboard.csv")
    all_table=leaders.loc[leaders.period=="all"].set_index("model")
    development=leaders.loc[leaders.period=="development_2020_2024"].set_index("model")
    confirmation=leaders.loc[leaders.period=="confirmation_2025"].set_index("model")
    families=selection["family_winners"]
    comparison=list(dict.fromkeys(["uncorrected","season_to_date","ewma_w3_h2",families["ewma"],
        families["precision"],families["kalman"],families["trend"],"last_month",
        families["direct_monthly"],families.get("direct_fortnightly","last_month"),families["direct_weekly"],
        families.get("direct_daily",chosen),chosen]))
    simple=all_table.loc["last_month"]
    best=all_table.loc[chosen]
    improve=100*(1-best.combined/simple.combined)
    improve2025=100*(1-confirmation.loc[chosen,"combined"]/confirmation.loc["last_month","combined"])
    raw_improve_x=100*(1-best.x_cm/all_table.loc["uncorrected","x_cm"])
    raw_improve_z=100*(1-best.z_cm/all_table.loc["uncorrected","z_cm"])
    uncertainty=pd.read_csv(DEST/"uncertainty.csv")
    ci=uncertainty.loc[(uncertainty.period=="all")&(uncertainty.method==chosen)&(uncertainty.baseline=="last_month")].iloc[0]
    ci2025=uncertainty.loc[(uncertainty.period=="confirmation_2025")&(uncertainty.method==chosen)&(uncertainty.baseline=="last_month")].iloc[0]
    years=pd.read_csv(DEST/"year-results.csv")
    selected_years=years.loc[years.model==chosen].set_index("season")
    baseline_years=years.loc[years.model=="last_month"].set_index("season")
    nested=pd.read_csv(DEST/"nested-year-validation.csv")
    short=pd.read_csv(DEST/"short-period-sensitivity.csv")
    short_all=short.loc[short.period=="all"].set_index("model")
    short_gain=100*(1-short_all.loc[chosen,"combined"]/short_all.loc["last_month","combined"])
    replay=pd.read_csv(DEST/"independent-replay-sensitivity.csv")
    eq=replay.loc[replay.centering=="equal_cell"].groupby("model")[["n","sse"]].sum()
    eq_gain=100*(1-np.sqrt(eq.loc[chosen,"sse"]/eq.loc["last_month","sse"]))
    game=pd.read_csv(DEST/"game-losses.csv.gz")
    game["mse"]=(game.x_sse+game.z_sse)/(2*game.n)
    g=game.groupby("model").mse.mean()
    game_gain=100*(1-np.sqrt(g[chosen]/g["last_month"]))
    park=pd.read_csv(DEST/"park-scores.csv")
    park=park.groupby(["park","model"])[["n","x_sse","z_sse"]].sum()
    park["rmse"]=np.sqrt((park.x_sse+park.z_sse)/(2*park.n))
    park_rmse=park.rmse.unstack()
    park_gain=100*(1-park_rmse[chosen]/park_rmse.last_month)
    save(park_gain.rename("improvement_pct").reset_index(),"selected-park-improvement.csv")
    # Figure 1: same definitions in the model-selection and confirmation periods.
    chart_methods=[m for m in comparison if m!="uncorrected"]
    fig,axes=plt.subplots(1,2,figsize=(14,7.2),layout="constrained")
    for ax,table,title in zip(axes,[development,confirmation],["2020~2024 · 설정 선택","2025 · 후속 확인"]):
        vals=table.loc[chart_methods,"combined"]
        ax.barh(range(len(vals)),vals,color=["#087e8b" if m==chosen else "#bdcbd8" for m in chart_methods])
        ax.set_yticks(range(len(vals)),[label(m,configs) for m in chart_methods],fontsize=9)
        ax.invert_yaxis()
        ax.set(title=title,xlabel="종합 RMSE (cm, 0.4초 진단 시각)")
        ax.set_xlim(0,vals.max()*1.12)
        for i,v in enumerate(vals):ax.text(v+.015,i,f"{v:.3f}",va="center",fontsize=9)
        ax.grid(axis="x",alpha=.15)
    fig.suptitle("자동 보정 방식 비교 · 낮을수록 좋음",fontsize=17,fontweight="bold")
    fig.savefig(DEST/"method-comparison.png",dpi=160,facecolor="white")
    plt.close(fig)
    # Figure 2: year and venue heterogeneity, not just one pooled score.
    fig,axes=plt.subplots(1,2,figsize=(13,5),layout="constrained")
    x=selected_years.index.to_numpy()
    axes[0].plot(x,baseline_years.loc[x,"combined"],"o-",color="#8a97a7",label="지난달 계수")
    axes[0].plot(x,selected_years.combined,"o-",color="#087e8b",label="선택한 방식")
    axes[0].set(title="시즌별 재현",xlabel="시즌",ylabel="종합 RMSE (cm)",xticks=x)
    axes[0].legend(frameon=False)
    axes[0].grid(alpha=.15)
    ordered=park_gain.sort_values()
    axes[1].barh(ordered.index,ordered.values,color=["#087e8b" if v>=0 else "#b5513a" for v in ordered])
    axes[1].axvline(0,color="#667",lw=.8)
    axes[1].set(title="구장별 추가 개선 · 지난달 계수 대비",xlabel="종합 RMSE 감소율 (%)")
    fig.savefig(DEST/"stability.png",dpi=170,facecolor="white")
    plt.close(fig)
    rows=[]
    for method in comparison:
        v=all_table.loc[method]
        rows.append([label(method,configs),f"{v.x_cm:.3f}",f"{v.z_cm:.3f}",f"{v.combined:.3f}",
                     f"{confirmation.loc[method,'combined']:.3f}"])
    performance_table=md_table(["방식","전체 X","전체 Z","전체 종합","2025 종합"],rows)
    year_table=md_table(["시즌","지난달 계수","선택 방식","추가 개선"],
        [[year,f"{baseline_years.loc[year,'combined']:.3f}",f"{r.combined:.3f}",
          f"{100*(1-r.combined/baseline_years.loc[year,'combined']):.2f}%"] for year,r in selected_years.iterrows()])
    nested_table=md_table(["평가 시즌","앞선 시즌들로 선택한 설정","그해 추가 개선"],
        [[r.season,label(r.selected,configs),f"{r.improvement_vs_last_month_pct:.2f}%"] for r in nested.itertuples()])
    top_table=md_table(["선택기간 순위","설정","2020~2024 종합","2025 종합"],
        [[i+1,label(m,configs),f"{row.combined:.5f}",f"{confirmation.loc[m,'combined']:.5f}"]
         for i,(m,row) in enumerate(development.drop(index="uncorrected").head(10).iterrows())])
    universe=sorted(park_rmse.index)
    worse=park_gain.loc[park_gain<0]
    park_text=(f"구장 단위로는 {len(park_gain)-len(worse)}/{len(park_gain)}곳에서 개선됐다. " +
               ("악화된 구장은 "+", ".join(f"{p}({-v:.2f}% 악화)" for p,v in worse.items())+"다." if len(worse) else "모든 평가 구장에서 개선됐다."))
    interval={"daily":"매일","weekly":"매주 월요일","fortnightly":"격주 월요일","monthly":"매월 1일"}[config["frequency"]]
    exact_weekly=""
    if chosen!=families["direct_weekly"]:
        wc=uncertainty.loc[(uncertainty.period=="confirmation_2025")&(uncertainty.method==chosen)&(uncertainty.baseline==families["direct_weekly"])].iloc[0]
        exact_weekly=f"선택 방식은 주별 최상위 후보보다 2025 종합 오차가 {wc.improvement_pct:.2f}% 작았다. 이 차이의 참고 95% 구간은 {wc.improvement_ci95_low:.2f}~{wc.improvement_ci95_high:.2f}%다."
    report=f"""# 자동 구장 편향 보정: {len(configs)}개 설정의 시간순 비교

2026-09-20 · 현재 봉인된 2020~2025 경기 스냅샷을 사용한 후향적 연구

## 이번에 고른 방식

**{interval} 최근 {config['window']}일 자료로 다시 추정하고, 자료가 {config['half']:g}일 오래될 때마다 가중치를 절반으로 줄이는 방식**을 기본 후보로 권한다.
설정 ID는 `{chosen}`다. 월별 계수끼리 평균내는 단계보다, 최근 경기 자료에 직접 시간 가중치를 주어 구장 효과를 다시 적합하는 단계에서 개선이 컸다.

같은 41,477개 투수·경기·구종 셀에서 지난달 계수 대비 종합 RMSE가 **{simple.combined:.3f} → {best.combined:.3f}cm, {improve:.2f}% 감소**했다.
2025년만 보면 **{confirmation.loc['last_month','combined']:.3f} → {confirmation.loc[chosen,'combined']:.3f}cm, {improve2025:.2f}% 감소**했다.
보정 없음 대비 개선은 X {raw_improve_x:.1f}%, Z {raw_improve_z:.1f}%다. 큰 효과는 구장 보정 자체에서 나오며, 자동 갱신 방식의 개선은 그 위에 더해지는 효과다.

여기서 “최선”은 이번 후보·표본·평가 기준에서의 최선이다. 인접한 반감기·기간 설정의 작은 차이까지 확정적인 우열로 해석하지 않는다.
특히 같은 일별·7일 반감기에서 최근 56일과 84일의 전체 종합 RMSE는 각각 {all_table.loc['daily_w56_h7','combined']:.5f}, {all_table.loc['daily_w84_h7','combined']:.5f}cm로 사실상 같다.
84일은 탐색 규칙에 따라 선택한 기본값이며, 56일보다 실질적으로 우월하다는 의미는 아니다.
2025년만 보고 반감기를 3.5일로 바꾸지는 않았다. 7일은 2020~2024년으로 고른 설정이다.
{exact_weekly}

## 실제로 비교한 방법

1차로 63개 보정 설정을 비교한 뒤, 선택기간에서 84일 창·14일 반감기·주별 갱신이 좋아 탐색 경계를 넓혔다.
일별·격주 갱신, 3.5·7·10·21일 반감기, 112일 창 등을 추가해 **보정 후보 {len(configs)}개와 무보정 대조군 1개**를 같은 표본에서 비교했다.

- 지난달 계수, 시즌 누적 추정.
- 최근 2·3·6개월 계수의 지수 가중평균, 재귀 평활화.
- 월별 계수의 추정 분산을 사용하는 신뢰도 가중.
- 구장 간·X/Z 공분산을 반영한 칼만 필터, 관측 급변에 반응하는 적응형 칼만 필터.
- 최근 월별 추세를 약하게 연장하는 방식.
- 최근 28·56·84·112일 자료의 직접 재추정, 월별·격주·주별·일별 갱신.
- 큰 잔차의 영향을 줄이는 Huber 재추정.

각 계열의 대표 설정은 2020~2024년 성능으로 골랐다. 아래 cm는 모두 **0.4초 공통 진단 시각** 기준이다.

{performance_table}

![설정 선택과 2025 확인 비교](calibration-search/method-comparison.png)

월별 평활화와 칼만 필터는 단순 지난달 계수를 안정적으로 능가하지 못했다. 월이 끝날 때까지 기다리는 지연을 줄이는 쪽이 이번 자료에서는 더 효과적이었다.
이는 비교 결과에 대한 해석이며, 구장 장비가 실제로 그 주기로 변한다는 직접 증거는 아니다.

## 어떤 검증인가

**계수를 만들 때 평가 경기보다 나중에 열린 경기의 기록은 사용하지 않았다.**
월별 방식은 월초 이전, 주별 방식은 월요일 이전, 일별 방식은 당일 이전 자료만 사용했다.
모든 갱신은 해당 시즌 자료만 쓰고, 이전 시즌 계수는 승계하지 않았다.
미래 관측을 훈련에서 제외하는 [시간순 교차검증 원칙](https://otexts.com/fpp3/tscv.html)을 적용했다.

**설정 선택은 2020~2024년 32,713개 셀, 후속 확인은 2025년 8,764개 셀로 분리했다.**
다만 2025년은 앞선 분석에서 이미 집계 성능을 살펴본 자료이며 이번에도 탐색적 후속 확인이다.
완전히 미개봉한 최종 시험이나 2026년 전향적 검증으로 표현하지 않는다.
또한 현재 sealed revision을 사용했으므로 경기 당시의 수집·정정 완료 시점까지 재현한 운영 백테스트는 아니다.

단위 셀은 같은 투수·경기·구종의 5구 이상 평균이다. 회귀에는 투수×구종×달 고정효과, 구종별 구속의 1·2차 항,
타석 방향과 볼·스트라이크 카운트를 넣었다. 구장 효과를 추정할 때 기본 셀 가중치는 `min(투구 수,30)`이다.
평가에서는 모든 방법에 동일한 과거 구속·타석·카운트 보정을 적용한 뒤, 해당 평가 월의 투수·구종 평균을 제거했다.
이 마지막 평균 제거는 점수 계산만을 위한 것으로, 보정계수 생성에는 쓰이지 않는다.

따라서 평가 대상은 **동일 투수·구종의 경기장 간 일관성**이다. 다음 투구의 절대 구위 예측 정확도나 센서 오차의 정답과 일치하는 정도가 아니다.
종합 RMSE는 `sqrt((X 잔차제곱합 + Z 잔차제곱합)/(2×셀 수))`이며 셀과 두 축을 같은 비중으로 평가한다.

모든 방법은 동일한 24개 시즌·월, 41,477개 셀에서 비교했다. 구장당 최소 5경기·20투수와 비교 연결성을 요구했다.
짧은 기간 방식이 이 조건을 못 채운 구장은 당시 이용 가능한 최근 월별 추정치, 이어서 시즌 누적치로 대체했다.
선택 방식의 평가 셀 대체 비율은 **{best.fallback_pct:.2f}%**였다. 평가 범위는 시즌 중 5~9월의 지원 가능한 월이며, 개막 초기·비시즌·희소 구장은 별도 검증이 필요하다.

## 특정 해나 구장만 좋아졌는가

{year_table}

{park_text}

![시즌 및 구장별 개선](calibration-search/stability.png)

모형을 고르는 행위까지 시간순으로 반복했다. 2023년은 2020~2022년, 2024년은 2020~2023년,
2025년은 2020~2024년 결과만으로 설정을 선택한 뒤 다음 해 성능을 확인했다.

{nested_table}

## 차이가 얼마나 확실한가

선택 방식은 지난달 계수보다 **{int(ci.month_wins)}/{int(ci.months)}개 평가 월**에서 종합 제곱오차가 작았다.
시즌과 시즌 내 연속 평가 월 2개 묶음을 함께 재표집한 10,000회 대응 부트스트랩에서 추가 개선율의 참고 95% 구간은
**{ci.improvement_ci95_low:.2f}~{ci.improvement_ci95_high:.2f}%**였다.
2025년만의 참고 구간은 **{ci2025.improvement_ci95_low:.2f}~{ci2025.improvement_ci95_high:.2f}%**였다.
일부 평가 월 사이에는 공백이 있어 묶음이 항상 연속된 달력 월은 아니다.
연도가 6개, 2025년 평가 월이 5개뿐이고 여러 설정을 탐색했으므로, 이 구간은 확정적 유의성 판정으로 쓰지 않는다.

평가 방법을 바꿔도 방향을 확인했다.

- 같은 투수·구종을 한 달 대신 약 14일 안에서 비교: {int(short_all.loc[chosen,'n']):,}개 셀, 추가 개선 {short_gain:.2f}%.
- 평가 시 투수·구종 평균을 투구 수 가중 대신 셀 동일 가중으로 계산: 추가 개선 {eq_gain:.2f}%.
- 평가 경기를 동일 비중으로 집계: 추가 개선 {game_gain:.2f}%.

선택기간의 상위 설정은 다음과 같다. 소수점 아래 작은 순위 차이보다 최근 자료를 빠르게 반영한다는 공통점을 중시한다.

{top_table}

## 자동 계산에 사용할 구체적인 규칙

1. **평가면:** 모든 시즌을 중간면 `y=17/24 ft`에 맞춘다. 원천 `cross_plate_y`는 보존한다.
2. **자료 창:** 계산 시점 이전의 해당 시즌 최근 {config['window']}일을 읽는다. {interval} 새 계수를 계산한다.
3. **가중치:** `min(셀 투구 수,30) × 2^(-경과일/{config['half']:g})`를 회귀에 직접 준다. 원시 구장 평균에 적용하지 않는다.
4. **비교 조건:** 동일 투수·구종·달과 구속·타석 방향·카운트를 통제한다. 최소 5경기·20투수, 다른 구장과 연결된 표본을 확인한다.
5. **기준점:** 잠실 대비 차이를 추정하고, 동일한 구장 집합의 고정 가중치로 중심화한다. 잠실의 실제 오차가 0이라는 가정은 하지 않는다.
6. **저장:** 계수는 `kx/kz` 가속도 단위(ft/s²)로 저장한다. 보고서의 cm 값을 가속도로 바꾸는 나눗수는 `{SCALE:.4f}`다.
7. **적용:** `kx_corrected=kx_raw-bx`, `kz_corrected=kz_raw-bz`. 화면에서는 사용하는 궤적 시각 T에 따라 `0.5×T²×30.48`을 곱한다.
8. **이력:** 계산 시점, 유효 시작 시점, 자료 범위·해시, 표본 수, 불확실성, 모델 버전을 남긴다. 월말 스냅샷도 보관할 수 있다.

자료가 {config['half']:g}일 더 오래될 때 회귀 가중치가 절반이 된다는 뜻이다. 경기 수와 투구 수가 다르므로 달별 실제 비중이 항상 고정되지는 않는다.
지수 감쇠의 기본 개념은 [NIST 설명](https://www.itl.nist.gov/div898/handbook/pmc/section4/pmc43.htm)과 같다.
칼만 후보는 [Welch·Bishop의 재귀 추정식](https://homepages.inf.ed.ac.uk/rbf/CVonline/LOCAL_COPIES/WELCH/kalman.html)을 바탕으로,
월별 측정 공분산과 무작위 변화 분산을 분리했다. 월별 공분산은 투수·경기 2방향 군집 샌드위치로 계산하고,
수치적으로 음수가 될 수 있는 고유값에 0.04cm² 바닥값을 적용했다.

신규 구장은 별도 ID로 시작한다. 대전 구장과 2025년 신구장은 합치지 않았다. 표본 부족 시 근거 없는 신규 계수를 확정하지 않으며,
실시간 운영에서는 추정 상태와 자료 나이를 함께 제공하는 것이 적절하다. 개막 초기·장기 결측·비시즌 승계 정책은 이번 선택의 검증 범위 밖이다.

이 분석은 궤적의 초기 진행 방향에 대해 정렬한 가속도 기반 무브먼트다. 중력 제거 IVB라고 해석하지 않는다.
구장 효과에는 관측 장비뿐 아니라 날씨·환경이나 충분히 통제되지 않은 실제 변화도 섞일 수 있다.
절대적인 장비 오차를 분리하려면 별도 기준 장비나 실험 자료가 필요하다.

## 재현과 계산 확인

원본 4,693경기·1,428,758개 실제 투구의 읽기 전용 추출에서 중간면 기준 셀을 다시 구성했다.
분석용 파일만 추가했으며, 원천 데이터·DB fact·서비스 보정 로직은 변경하지 않았다.

- 기존 5개 방식의 제곱오차 재현 최대 차이: `{verification['previous_5_method_max_sse_difference']:.2e}`.
- 알려진 편향을 넣은 합성 자료의 계수 복원 최대 오차: `{verification['synthetic_recovery_error']:.2e}`.
- 순서 변경·공통 상수 이동에 대한 계수 불변성, 동일 평가 표본, 훈련일 < 적용일, 경기별/월별 합산 일치를 확인했다.
- 저장된 계수만 읽는 별도 재생 경로로 선택 방식의 점수도 재현했다.

실행 순서는 `calibration_search.py --extended`, `evaluate_calibration_search.py`, `calibration_search_diagnostics.py`, `render_calibration_search.py`다.
원천 gzip 경로는 기존 [snapshot.json](snapshot.json)에 있다.

[전체 설정](calibration-search/protocol.json) · [86개 설정 전체 점수](calibration-search/leaderboard.csv) ·
[최종 선택](calibration-search/selection.json) · [월별 점수](calibration-search/scores.csv) ·
[훈련 시점 감사](calibration-search/training-audit.csv) · [수치 검증](calibration-search/verification.json) ·
[연도별 순차 선택](calibration-search/nested-year-validation.csv) · [불확실성](calibration-search/uncertainty.csv)
"""
    (OUT/"calibration-search.md").write_text(report,encoding="utf-8")
    body=markdown.markdown(report,extensions=["tables","fenced_code","toc"])
    for name in ["method-comparison.png","stability.png"]:
        b64=base64.b64encode((DEST/name).read_bytes()).decode()
        body=body.replace(f'src="calibration-search/{name}"',f'src="data:image/png;base64,{b64}"')
    document=f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>자동 구장 편향 보정 · 모형 비교</title><style>
:root{{color-scheme:light}}body{{margin:0;background:#f0f4f7;color:#21313e;font:16px/1.8 'Malgun Gothic',sans-serif}}
main{{max-width:1180px;margin:32px auto;background:white;padding:42px 52px;border-radius:18px;box-shadow:0 10px 45px #17324c0b}}
h1{{font-size:31px;line-height:1.4;color:#12374c;margin-top:0}}h2{{font-size:23px;margin-top:48px;color:#155065;border-bottom:1px solid #d8e4e9;padding-bottom:10px}}
p,li{{word-break:keep-all;overflow-wrap:anywhere}}strong{{color:#086b76}}table{{border-collapse:collapse;width:100%;font-size:14px;margin:22px 0;display:block;overflow-x:auto}}
th,td{{border-bottom:1px solid #dbe3e9;padding:10px 13px;white-space:nowrap;text-align:right}}th:first-child,td:first-child{{text-align:left}}th{{background:#eaf3f6;color:#214d60}}
tr:nth-child(even){{background:#f8fafc}}img{{max-width:100%;height:auto;margin:20px 0}}code{{background:#edf3f7;padding:2px 5px;border-radius:4px;font-size:.91em}}
a{{color:#006f8c}}li{{margin:8px 0}}@media(max-width:750px){{main{{margin:0;padding:24px 18px;border-radius:0}}h1{{font-size:25px}}}}
</style></head><body><main>{body}</main></body></html>"""
    (OUT/"calibration-search.html").write_text(document,encoding="utf-8")
    policy=dict(model_id=chosen,status="research recommendation; not deployed",configuration=config,
                coordinate_plane_ft=17/24,coefficient_units="ft/s^2",raw_source_immutable=True,
                effective_at="after training cutoff; only earlier games",evaluation_scope="supported in-season May-September comparisons",
                combined_rmse_all=float(best.combined),extra_gain_vs_last_month_pct=float(improve),
                confirmation_2025_gain_pct=float(improve2025),source_protocol="protocol.json")
    dump_json(policy,"recommended-policy.json")
    print(json.dumps(policy,ensure_ascii=False,indent=2),flush=True)


if __name__=="__main__":
    main()
