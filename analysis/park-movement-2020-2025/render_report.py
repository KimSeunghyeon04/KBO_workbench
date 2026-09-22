"""Generate standalone figures and a readable Korean report from saved results."""

from pathlib import Path
import base64
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import TwoSlopeNorm
import numpy as np
import pandas as pd
import markdown

OUT = Path(__file__).resolve().parent
plt.rcParams.update({"font.family":"Malgun Gothic", "axes.unicode_minus":False,
    "font.size":11, "axes.spines.top":False, "axes.spines.right":False})
e = pd.read_csv(OUT / "park_effects.csv")
c = pd.read_csv(OUT / "coverage.csv")
v = pd.read_csv(OUT / "validation_summary.csv")
m = pd.read_csv(OUT / "monthly_effects.csv")
s = pd.read_csv(OUT / "sensitivity.csv")
comparison = pd.read_csv(OUT / "model_comparison.csv")
snapshot = json.loads((OUT / "snapshot.json").read_text())
parks = ["고척","광주","대구","대전구","대전신","문학","사직","수원","잠실","창원"]

fig, axes = plt.subplots(1,2,figsize=(13,7.4),layout="constrained")
for ax,metric,title in zip(axes,["x_cm","z_cm"],["좌우 변위 편향 (X)","상하 변위 편향 (Z)"]):
    matrix = e.pivot(index="park",columns="season",values=metric).reindex(parks)
    cmap = plt.get_cmap("RdBu_r").copy()
    cmap.set_bad("#edf0f4")
    im = ax.imshow(matrix.to_numpy(),cmap=cmap,norm=TwoSlopeNorm(vmin=-16,vcenter=0,vmax=16),aspect="auto")
    ax.set(xticks=range(6),xticklabels=range(2020,2026),yticks=range(len(parks)),
           yticklabels=[p.replace("대전구","대전 (구장)").replace("대전신","대전 (신구장)") for p in parks],title=title)
    for i in range(len(parks)):
        for j in range(6):
            val = matrix.iloc[i,j]
            ax.text(j,i,"—" if np.isnan(val) else f"{val:+.1f}",ha="center",va="center",
                    color="white" if abs(val)>10 else "#172d3d",fontsize=12)
    ax.tick_params(length=0,pad=8)
fig.suptitle("투수·구종·월·구속을 통제해도 구장 차이가 남는다",fontsize=19,fontweight="bold")
fig.colorbar(im,ax=axes,label="시즌별 비교 기준 대비 관측 편향 (cm)",shrink=.73,pad=.025)
fig.savefig(OUT/"park_bias_heatmap.png",dpi=170,facecolor="white")
plt.close(fig)

fig,axes=plt.subplots(1,2,figsize=(12,5.2),layout="constrained")
focus=e[(e.season==2025)&(e.games>=20)].sort_values("x_cm")
for ax,metric,title in zip(axes,["x_cm","z_cm"],["좌우 X", "상하 Z"]):
    ax.axvline(0,color="#b4bec9",lw=1)
    ax.errorbar(focus[metric],range(len(focus)),xerr=[focus[metric]-focus[metric+"_low"],
        focus[metric+"_high"]-focus[metric]],fmt="o",color="#176579",capsize=3,ms=6)
    ax.set(yticks=range(len(focus)),yticklabels=focus.park,xlabel="상대 편향 (cm)",title=title)
    ax.grid(axis="x",alpha=.2)
fig.suptitle("2025 주요 구장 · 추정치와 95% 신뢰구간",fontsize=17,fontweight="bold")
fig.savefig(OUT/"park_bias_2025_ci.png",dpi=160,facecolor="white")
plt.close(fig)

fig,axes=plt.subplots(1,2,figsize=(12,5),layout="constrained")
colors={"수원":"#bb4a2b","문학":"#2165a3","고척":"#149081","사직":"#8151a1"}
for ax,metric,title in zip(axes,["x_cm","z_cm"],["좌우 X", "상하 Z"]):
    for park in colors:
        f=m[(m.season==2025)&(m.park==park)&(m.month<=9)&(m.games>=5)]
        ax.plot(f.month,f[metric],"o-",label=park,color=colors[park],lw=2)
    ax.axhline(0,color="#aab4bf",lw=1)
    ax.set(xticks=range(3,10),xlabel="2025년 월",ylabel="월별 상대 편향 (cm)",title=title)
    ax.grid(alpha=.16)
    ax.legend(ncols=2,frameon=False)
fig.suptitle("2025년에는 연간 고정값만으로 남는 변화가 있다",fontsize=17,fontweight="bold")
fig.savefig(OUT/"monthly_bias_2025.png",dpi=160,facecolor="white")
plt.close(fig)


def table(headers, rows):
    return "| "+" | ".join(headers)+" |\n| "+" | ".join(["---"]*len(headers))+" |\n"+"\n".join(
        "| "+" | ".join(str(x) for x in row)+" |" for row in rows)


coverage_table=table(["시즌","봉인 경기","실제 투구","유효 무브먼트","유효 비율"],[
    [int(r.season),f"{r.manifest_games:,}",f"{r.actual:,}",f"{r.valid:,}",f"{r.valid_pct:.1f}%"]
    for r in c.itertuples()])
main_table=table(["구장","경기","투수","좌우 편향 cm (95% CI)","상하 편향 cm (95% CI)"],[
    [r.park,int(r.games),int(r.pitchers),f"{r.x_cm:+.2f} [{r.x_cm_low:+.2f}, {r.x_cm_high:+.2f}]",
     f"{r.z_cm:+.2f} [{r.z_cm_low:+.2f}, {r.z_cm_high:+.2f}]"]
    for r in e[(e.season==2025)&(e.games>=20)].itertuples()])
cv_rows=[]
for season in range(2020,2026):
    f=v[v.season==season].set_index("metric")
    cv_rows.append([season,f"{int(f.loc['x_cm','n']):,}"]+[
        f"{f.loc[k,'raw_rmse']:.2f} → {f.loc[k,'corrected_rmse']:.2f} ({f.loc[k,'rmse_reduction_pct']:.1f}% 감소)"
        for k in ["x_cm","z_cm"]])
cv_table=table(["시즌","검증 셀 수","좌우 RMSE cm","상하 RMSE cm"],cv_rows)
model_rows=[]
for season in range(2020,2026):
    f=comparison[(comparison.season==season)&comparison.metric.isin(["x_cm","z_cm"])]
    model_rows.append([season]+[" / ".join(f"{f[(f.model==model)&(f.metric==k)].rmse.iloc[0]:.2f}"
        for k in ["x_cm","z_cm"]) for model in ["annual","monthly","pitch_type"]])
model_table=table(["시즌","구장×시즌 (X / Z)","구장×월 (X / Z)","구장×시즌×구종 (X / Z)"],model_rows)
sens_rows=[]
for park in ["수원","문학","고척","사직"]:
    rows=s[(s.season==2025)&(s.park==park)].set_index("variant")
    orig=e[(e.season==2025)&(e.park==park)].iloc[0]
    sens_rows.append([park,f"{orig.x_cm:+.1f} / {orig.z_cm:+.1f}"]+[
        f"{rows.loc[k,'x_cm']:+.1f} / {rows.loc[k,'z_cm']:+.1f}"
        for k in ["away_only","fastball_only","28day_fe"]])
sens_table=table(["구장","주모형 X / Z","원정 투수만","직구만","28일 구간 통제"],sens_rows)

report=f"""# 2020~2025 KBO 투구 무브먼트의 구장 편향 분석

분석 기준: 2026-09-20 08:20 KST의 로컬 PostgreSQL current sealed revision. 단위는 별도 표시가 없으면 cm다.

후속 검토: [월별 자동 편향 계산 설계와 과거→다음 달 검증](automatic-calibration.md).

**구장별 상대 편향이 뚜렷하다. 투수·구종·월과 구속 등을 통제한 후에도 반복되며, 다른 경기와 다른 투수에 적용한 교정에서 오차가 줄었다. 과거 여섯 시즌을 하나의 구장 상수로 보정하는 방식은 적절하지 않다.**

이번 결과는 구장과 연관된 체계적 차이를 추정한다. 장비의 절대 오차를 측정한 것은 아니다. 기온·기압·습도·바람, 마운드와 실제 투구 변화도 섞일 수 있으므로, 명칭은 우선 **구장 표준화 무브먼트**가 정확하다. 독립된 측정 장비나 교정 기록 없이 전부 센서 오류라고 확정할 수 없다.

## 표본과 지표

{coverage_table}

총 **4,693경기 / 실제 투구 1,428,758개 / 유효 궤적 1,361,930개(95.3%)**다. 연결된 트래킹은 1,377,049개로, 미연결 51,709개와 기하 조건을 통과하지 못한 연결 관측 15,119개를 분석에서 제외했다. 원문과 fact는 삭제하거나 수정하지 않았다.

시범경기·정규시즌·포스트시즌 등이 섞인 현재 수집 범위이며, 정규시즌 전수라고 가정하지 않는다. 로컬 current 작업본에는 2023년 원천 수집 실패 4건과 2022 올스타전 quarantine 1건이 남아 있어 이들은 분석 정본에 포함하지 않았다. 2022~2023 울산·포항, 2024 이천(두산)은 연결 트래킹이 없어 편향을 추정할 수 없다.

모형에는 구종명이 있고, 같은 투수·경기·구종에 유효 투구가 5개 이상이며, 같은 투수·구종·월에 둘 이상의 구장에서 던진 셀만 넣었다. 최종 **71,566개 셀 / 1,095,863구**다. 한 선발의 많은 투구가 과도하게 지배하지 않도록 셀 가중치는 `min(투구 수, 30)`으로 제한했다. 검증 오차는 셀당 동일 가중치다.

현재 워크벤치의 정의를 그대로 사용했다. `kx = ax - vx0/vy0*ay`, `kz = az - vz0/vy0*ay`이며, 해당 시즌 유효 `직구`의 평균 궤적이 플레이트에 도착하는 시각 T에서 비교한다.

```text
X = (kx − 시즌 직구 평균 kx) × T²/2 × 30.48
Z = (kz − 시즌 직구 평균 kz) × T²/2 × 30.48
```

이는 초기 위치·진행 방향을 제거한 동일 시각 변위다. **IVB, 회전수, 실제 투구 코스가 아니다.** X의 부호는 원천 좌표를 유지하고 Z의 양수는 위쪽이다. X를 투수의 팔 쪽/글러브 쪽으로 해석하지 않는다. IVB와 중력을 포함한 움직임은 [MLB의 지표 설명](https://baseballsavant.mlb.com/pitch-movement)에서도 구분한다. 궤적 정의에 따라 운동량 해석이 달라지는 점은 [Alan Nathan의 자료](https://baseball.physics.illinois.edu/pitchtracker.html)를 참고했다.

원천 `cross_plate_y`는 2020~2023년에 1.4167ft였고, 2024년에는 대부분 0.7083ft로 달라진다. 후속 확인 결과 **2025년 1.4167ft는 3월 8~18일 시범경기 42경기·12,235구에만 나타나며, 3월 22일 개막 이후 737경기·222,722구는 모두 0.7083ft**다. 정규시즌 내내 두 값이 혼재한다는 뜻은 아니다. 2024년의 예외는 3월 14일 잠실 경기 첫 48구뿐이고 같은 경기의 이후 251구는 0.7083ft다. 보존된 Naver 원문에도 이 전환이 있으며 수집 코드는 값을 그대로 전달한다. [구장별 집계](plate_reference_by_park.csv)와 [원문 hash 확인](plate_reference_source_check.json)을 남겼다.

두 수치는 각각 약 17인치와 8.5인치다. 통상적인 PITCHf/x 좌표계에서 [1.417ft는 홈플레이트 앞면](https://physics.csuchico.edu/baseball/resources/POBActivities/pitchfx/ws2012.shtml)에 해당하므로, 0.7083ft는 중간면에 해당하는 것으로 해석된다. [2024년 KBO ABS 규정](https://www.koreabaseball.com/MediaNews/Notice/View.aspx?bdSe=9984)은 좌우를 중간면에서 판단하고 상하는 중간면·끝면을 함께 본다. 이에 맞춰 제공자가 출력 좌표의 평가면을 바꿨다는 설명이 가장 잘 맞지만, Naver의 필드 명세나 변경 기록으로 확정한 사유는 아니다. [2025 시범경기도 동일한 ABS 규정을 적용](https://www.koreabaseball.com/MediaNews/Notice/View.aspx?bdSe=11396)하므로 앞면 값이 제공됐다는 사실을 앞면에서 판정했다는 뜻으로 해석하면 안 된다. 시범경기·정규경기의 제공 설정이나 데이터 경로 차이가 의심된다.

이번 분석은 기존 공개 계산 함수처럼 관측값을 유지했다. 두 면의 간격은 약 21.59cm이며, 저장된 2024~2025 궤적을 두 면에서 평가하면 도착 시각 차이의 중앙값은 약 6.20ms다. 도착 시각·실제 코스를 서로 비교할 때는 원천값을 보존하면서 별도의 공통 평면 파생값을 계산하는 것이 적절하다. 이번 X·Z는 시즌 내 공통 T와 kx·kz를 사용하므로 개별 공의 cross_plate_y 차이가 X·Z에 직접 더해지는 구조는 아니다. 여기서 도출한 계수를 별도의 IVB 계산에 그대로 옮기면 안 된다.

## 같은 투수와 구종을 비교한 결과

시즌마다 별도로 다음 가중 고정효과 모형을 적합했다.

```text
셀 평균 무브먼트
  = 투수×구종×월 고정효과
  + 구장 효과
  + 구종별 50ft 속력의 1차·2차 항
  + 좌타자 비율 + 평균 볼·스트라이크 카운트
  + 오차
```

좌우완·투구폼의 고정적 차이는 투수 효과에 포함된다. 구속은 중계 구속이 아닌 초기 속도 벡터의 크기다. 구장 효과의 투구 수 가중 평균을 시즌별 0으로 고정했다. **양수는 비교 기준보다 그 방향으로 더 크게 기록되는 성분이며, 교정할 때 빼는 값**이다. 신뢰구간은 투수와 경기의 이중 군집 상관을 반영했다. 개별 95% 구간이며 동시에 모든 구간이 참일 확률을 뜻하지 않는다.

![구장·시즌별 상대 편향](park_bias_heatmap.png)

고척의 상하 편향은 6시즌 내내 약 +7~+9cm, 수원의 좌우 편향은 +7~+15cm, 문학의 좌우 편향은 −6~−11cm 수준으로 반복된다. 창원 좌우는 2021 −5.3cm에서 2022 +3.0cm로 변했고, 구 대전도 2023 +11.5cm에서 2024 +4.1cm로 달라졌다. 한 번 계산한 구장 상수를 모든 시즌에 적용할 근거가 없다.

2025년 주요 구장 결과는 다음과 같다.

{main_table}

같은 조건의 공이 수원과 문학에서 기록될 때 좌우 차이는 추정상 **26.6cm**, 고척과 사직의 상하 차이는 **17.9cm**다. 이는 서로 다른 투수들의 단순 평균 차이가 아니다. 다만 모든 개별 투구에 같은 오차가 있다는 뜻도 아니다.

![2025년 주요 구장의 신뢰구간](park_bias_2025_ci.png)

2025년 `대전(신)`은 3~7월, `대전`은 7~10월에 나타난다. [2025년 신구장 개장에 대한 대전시 발표](https://www.daejeon.go.kr/drh/board/boardNormalView.do?boardId=normal_0189&menuSeq=1632&ntatcSeq=1475377281)와 경기 날짜를 근거로 같은 신구장의 표기 변경으로 보고 통합했으며, 이는 분석상의 구장 매핑 판단이다. 구장명을 따로 둔 민감도 분석에서도 상하 계수는 −2.07 / −2.06cm로 일치하고 좌우는 +1.08 / +1.75cm로, 주요 결론은 유지된다. 2020~2024의 구장은 별도 `대전구`다.

청주 2025는 좌우 +26.0cm지만 **2경기·16투수**뿐이다. 포항은 3경기, 울산은 8경기다. 이 표본에서 나온 작은 표준오차를 교정 안정성으로 해석하지 않는다. 자동 보정 대상에서 제외하고, 더 많은 경기와 장비 정보를 확보할 때까지 검토 대상으로 둔다.

## 검증에서 실제로 얼마나 개선됐는가

경기 ID의 SHA-256으로 경기를 5개 묶음으로 나눠, 한 경기의 모든 투구가 같은 검증 묶음에 들어가게 했다. 매번 80% 경기로 모형을 적합하고 나머지 경기의 셀 평균을 예측했다. 비교 모형은 투수·구종·월·구속·카운트 통제가 같고 구장 효과만 없다. 검증 경기에서 학습에 없던 투수·구종·월 조합은 예측하지 않았다. 이로 인해 검증 분모는 전체 셀과 다르다.

{cv_table}

6시즌 합산 RMSE는 좌우 **7.15 → 3.52cm(50.8% 감소)**, 상하 **4.81 → 3.14cm(34.7% 감소)**다. 이는 **경기별 구종 평균의 조건부 예측 오차**다. 개별 투구의 센서 오차가 이 비율만큼 줄었다거나 실제 구위가 변했다고 해석하면 안 된다.

추가로 투수 ID를 5개 묶음으로 나눠 다른 투수들로 구장 계수를 추정한 뒤, 처음 보는 투수의 동일 월·구종 내 구장 차이에 적용했다. 좌우 RMSE는 45~58%, 상하는 32~39% 줄었다. 특정 홈팀의 투수 구성만 설명한 결과일 가능성을 낮춘다. 이 검증은 검증 투수의 평균을 제거한 **구장 간 일관성 검증**이며, 신규 투수의 절대 구위를 예측하는 검증은 아니다.

{sens_table}

원정 투수만 써도 방향과 크기가 비슷하다. 직구만 쓰면 효과가 조금 커지므로 구종과 무관한 완전한 평행 이동으로 단정하지 않는다. 시즌 고정효과, 28일 구간, 동일 셀 가중치에서도 주요 구장 신호가 유지된다. 홈 투수만으로는 홈구장과 투수 효과가 강하게 겹쳐 독립된 구장 교정 근거로 삼지 않았다.

## 월별로 얼마나 달라지는가

![2025년 월별 구장 편향](monthly_bias_2025.png)

2025년 수원 좌우는 3월 약 +9.3cm에서 8월 +19.1cm로, 사직 상하는 3월 −3.4cm에서 8월 −11.5cm로 변한다. 월마다 별도로 식별한 상대 기준이므로 그 수치의 차이를 모두 한 장비의 변화량으로 해석할 수는 없다. 그래도 연간 상수만으로 남는 변화가 있고, 이를 검증 경기에서 비교할 필요가 있다.

구장×시즌, 구장×월, 구장×시즌×구종 모형이 **모두 예측할 수 있는 동일한 검증 셀**에서 비교했다. 아래는 좌우 / 상하 RMSE(cm)이며, 표본이 달라 앞 표와 약간 다르다.

{model_table}

월별 모형은 2025년에 연간 모형 대비 좌우 오차를 추가 8.4%, 상하를 3.9% 줄였고 2024년에도 개선됐다. 반면 2021~2022년에는 월별 모형이 오히려 나빠졌다. **전체 시즌에 무조건 월별 계수를 적용하면 안 된다.** 구종별 모형의 개선도 대체로 작다. 희소한 월·구종별 상수를 모두 자유롭게 적합하기보다 연간 값으로 수축하는 방식이 적절한 후속 후보다. 수축 강도와 모형 선택은 별도의 외부 검증에서 정해야 하며, 이번 비교로 최적값을 확정하지 않았다.

## 권장 교정 방식

1. **첫 단계는 구장×시즌의 X·Z 가산 교정이다.** `표준화 M = 관측 M − 추정 구장 편향`을 별도 분석값으로 제공한다. 이 보고서의 2025 근사 예는 수원 X에서 15.45cm를 빼고, 문학 X에는 11.11cm를 더하고, 고척 Z에서 8.72cm를 빼고, 사직 Z에는 9.16cm를 더하는 것이다. 시즌 전체 기준의 상대 교정이며 월별 정밀값은 아니다.
2. **2024~2025는 시간 변화를 허용하되 검증된 부분만 적용한다.** 구장×시즌의 기본값에 월별 편차를 더하고, 표본이 적은 달은 편차를 0 쪽으로 수축하는 모형을 다음 후보로 삼는다. 원정 투수에서도 재현되고, 보류 경기의 오차를 줄이는 경우에만 복잡도를 늘린다. 2020~2023에는 안정적인 연간 교정을 기본 후보로 둔다.
3. **구종별 편차는 두 번째 단계다.** 구종명이 잘못 분류됐거나 희소한 경우가 있으므로 단일 구종의 계수를 바로 확정하지 않는다. 공통 구장 효과에서 출발해 충분한 교차 구장 표본을 가진 구종의 추가 편차만 추정한다. 무브먼트로 만든 GMM 라벨을 그대로 원인 통제로 쓰면 편향이 구종 분류에 흡수될 수 있다.
4. **희소 구장은 자동 교정하지 않는다.** 운영 시작 기준의 제안은 최소 20경기·40투수·복수 구장과 연결된 표본이며, 이는 이번에 최적화한 통계적 임계값이 아니라 보수적인 운영 문턱이다. 미달이면 null과 `insufficient_support`를 반환하고 주요 홈구장 값을 대신 붙이지 않는다.
5. **계수와 적용 범위를 버전으로 고정한다.** 실제 구장 ID, 시즌·유효 날짜, 지표 정의, sourceHash, 관측/경기/투수 수, 추정치·표준오차, 모델 버전, 검증 결과를 함께 저장한다. 시즌이 바뀌거나 측정 설정이 바뀌면 다른 프로필이다. 2026년이나 미래 경기로 그대로 연장하지 않는다.

현재 화면의 좌표를 교정할 때는 그 좌표를 만드는 정렬 계수에서 처리하는 것이 일관적이다. `C = T²/2 × 30.48`이면 다음과 같다.

```text
kx_standardized = kx_raw − bX / C
kz_standardized = kz_raw − bZ / C
```

그 다음 **표준화한 시즌 직구의 평균·분포를 다시 계산**하고 같은 기준으로 각 공의 상대좌표와 GMM을 계산해야 한다. 현재 상대좌표에서 단순히 b를 뺀 뒤 예전 직구 타원체를 그대로 쓰면 기준이 어긋날 수 있다. 위 변환은 분석용 정렬 계수에만 적용하며 원천 `ax/az`, 실제 코스, 스트라이크존 판정이나 replay fact를 고쳐 쓰지 않는다.

3D 군집에는 Y(도착 깊이)도 들어간다. 부가 분석에서 깊이의 검증 RMSE도 7.23 → 3.89cm로 줄어 구장 성분이 관측됐다. 다만 cross_plate_y 기준과 비행 시계가 얽혀 있으므로 X·Z 교정만으로 3D 군집 전체가 교정됐다고 표시해서는 안 된다. **우선 X·Z만 표준화했다고 명시하고, Y·도착 시간의 별도 정의 및 검증 후 3D 분석에 확대**하는 것이 적절하다.

저장소 적용 위치는 순수 무브먼트 계산을 가진 `game-core`의 분석 경로다. persistence는 current typed fact와 프로필을 읽고, 서버가 같은 snapshot의 프로필·직구 기준·표본을 조합하며, 웹은 원본과 표준화 값을 표시한다. 브라우저에서 독립 교정식을 만들거나 봉인 DB의 좌표를 UPDATE할 필요가 없다. 분석 modelVersion과 캐시 키를 바꾸고, 보정된 기준과 표본이 같은 버전을 사용하는지 검증해야 한다.

## 해석의 한계와 재현

- 모든 구장의 공통 오차는 이 데이터만으로 알 수 없다. 계수는 상대 기준이며 절대적인 정답 무브먼트가 아니다.
- 기상·공기 밀도·바람·마운드·구장별 전략과 구종 오분류를 직접 통제하지 못했다. 센서 교정만이 목적이면 기상과 독립 장비 측정을 추가해야 한다.
- 많은 투구가 있어도 독립적인 근거는 경기·투수에 의해 제한된다. 특히 제2구장의 적은 경기 수를 투구 수로 대체할 수 없다.
- 무작위 경기 묶음 검증은 **과거 시즌을 사후 표준화하는 작업**을 검증한다. 미래 날짜 예측이나 실시간 보정 성능의 증거는 아니다. 월별 모형 선택 결과는 탐색적이며, 운영 선택에는 별도의 시간 순서 보류 검증이 필요하다.
- 일부 투구는 구속/구종 메타데이터나 유효 궤적이 없고, 수집 실패도 있어 누락이 무작위라고 보장하지 않는다.

DB는 `REPEATABLE READ READ ONLY` 트랜잭션으로 추출했고, `.data`, sealed revision, 앱 코드는 수정하지 않았다. SQL 및 분석 파일만 이 디렉터리에 생성했다. 앱 동작 변경이 없어 저장소 전체 lint/build/integration 대신 분석 수치와 추출 무결성 검증을 실행했다.

기존 공개 `alignPitchTrajectory`와 1,000개 실제 투구를 대조한 최대 차이는 5.7e−14였다. 알려진 편향을 심은 합성 자료에서 계수 복원 오차는 4.6e−14 이하였다. 모든 연간 모형의 설계행렬은 full rank이며, 구장 효과의 가중 평균 0 조건도 통과했다.

- [시즌·구장별 추정치와 신뢰구간 CSV](park_effects.csv)
- [경기 보류 검증 CSV](validation_summary.csv)
- [월별 추정치 CSV](monthly_effects.csv)
- [민감도 분석 CSV](sensitivity.csv)
- [모형 비교 CSV](model_comparison.csv)
- [경기 revision/hash manifest](manifest.csv)
- [추출 SQL](extract.sql), [추출 스크립트](extract.py), [주분석](analyze.py), [검증](verify.py), [추가 진단](diagnostics.py), [모형 비교](compare_models.py)

원시 투구 CSV는 로컬 임시 디렉터리에 gzip으로 보존했고 위치는 `snapshot.json`에 있다. 재실행은 `extract.py → analyze.py → diagnostics.py → compare_models.py → verify.py → render_report.py` 순서다. Python에 numpy/pandas/scipy/matplotlib/markdown이 필요하다. `analyze.py`는 지정된 snapshot에서 집계를 다시 만들므로 과거 집계를 새 추출에 재사용하지 않는다. 이번 결과를 보존한 채 새로운 시점의 분석을 수행하려면 별도 출력 디렉터리를 사용한다.

```text
manifest CSV SHA-256: {snapshot['manifest_csv_sha256']}
pitch CSV SHA-256: {snapshot['pitch_csv_sha256']}
```
"""
(OUT/"report.md").write_text(report,encoding="utf-8")
body=markdown.markdown(report,extensions=["tables","fenced_code"])
for filename in ["park_bias_heatmap.png","park_bias_2025_ci.png","monthly_bias_2025.png"]:
    encoded=base64.b64encode((OUT/filename).read_bytes()).decode()
    body=body.replace(f'src="{filename}"',f'src="data:image/png;base64,{encoded}"')
html='''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KBO 2020–2025 구장 무브먼트 편향</title><style>
body{font-family:"Malgun Gothic",sans-serif;background:#f2f5f7;color:#203240;margin:0;line-height:1.8}
main{max-width:1080px;margin:36px auto;padding:40px 52px;background:white;border-radius:12px}
h1{font-size:30px;letter-spacing:-1px}h2{font-size:23px;margin-top:46px;border-top:1px solid #dae2e6;padding-top:24px}
p,li{font-size:15px}strong{color:#104f64}a{color:#056f8b}img{max-width:100%;height:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.65;margin:22px 0}th{background:#eaf1f4;text-align:left}
th,td{padding:9px 10px;border-bottom:1px solid #dce4e8}tr:nth-child(even){background:#f8fafb}
pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px 20px;background:#eef3f5;font-size:13px;border-radius:6px}
code{font-family:Consolas,monospace}li{margin-bottom:10px}@media(max-width:760px){main{margin:0;padding:20px}table{display:block;overflow-x:auto}}
</style><main>'''+body+'</main></html>'
(OUT/"report.html").write_text(html,encoding="utf-8")
print("Created report.md, standalone report.html and three PNG figures")
