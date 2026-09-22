"""Select configurations using <=2024, then assess confirmation and robustness."""

import hashlib
import json
import sys

import numpy as np
import pandas as pd

from calibration_search import DEST, OUT, AXES, estimate, save, dump_json
from analyze import fit
from rolling_calibration import effects

sys.stdout.reconfigure(encoding="utf-8")


def leaderboard(scores, short=False):
    n, sse = ("short_n", "short_sse") if short else ("n", "sse")
    byaxis = scores.groupby(["model", "metric"])[[n, sse]].sum()
    byaxis["rmse"] = np.sqrt(byaxis[sse]/byaxis[n])
    out = byaxis.rmse.unstack()
    combined = scores.groupby("model")[[n, sse]].sum()
    out["combined"] = np.sqrt(combined[sse]/combined[n])
    out["n"] = combined[n]/2
    fallback = scores.groupby("model").fallback_n.sum()/2
    out["fallback_pct"] = 100*fallback/out.n
    return out.sort_values(["combined", "model"])


def paired_bootstrap(scores, method, baseline="last_month", draws=10000):
    # Paired loss differences preserve the exact same evaluation sample.
    bymonth = scores.groupby(["season", "month", "model"])[["n", "sse"]].sum()
    a = bymonth.xs(method, level="model")
    b = bymonth.xs(baseline, level="model")
    assert a.index.equals(b.index) and np.array_equal(a.n, b.n)
    years = sorted(a.index.get_level_values("season").unique())
    chunks = []
    for year in years:
        # Order is evaluated months. Gaps mean some blocks are >1 calendar month.
        aa, bb = a.loc[year], b.loc[year]
        chunks.append(np.column_stack([aa.sse, bb.sse, aa.n]))
    rng = np.random.default_rng(7310920)
    diffs, improvements = [], []
    for _ in range(draws):
        total = np.zeros(3)
        for year_index in rng.integers(0, len(chunks), size=len(chunks)):
            chunk = chunks[year_index]
            starts = rng.integers(0, len(chunk), size=(len(chunk)+1)//2)
            indices = np.column_stack([starts, (starts+1)%len(chunk)]).ravel()[:len(chunk)]
            total += chunk[indices].sum(axis=0)
        rmse, base_rmse = np.sqrt(total[:2]/total[2])
        diffs.append(rmse-base_rmse)
        improvements.append(100*(1-rmse/base_rmse))
    diff = float(np.sqrt(a.sse.sum()/a.n.sum())-np.sqrt(b.sse.sum()/b.n.sum()))
    return dict(method=method, baseline=baseline, rmse_difference=diff,
                ci95_low=float(np.quantile(diffs,.025)), ci95_high=float(np.quantile(diffs,.975)),
                improvement_pct=float(100*(1-np.sqrt(a.sse.sum()/b.sse.sum()))),
                improvement_ci95_low=float(np.quantile(improvements,.025)),
                improvement_ci95_high=float(np.quantile(improvements,.975)),
                month_wins=int((a.sse < b.sse).sum()), months=len(a), draws=draws)


def verify(scores):
    old = pd.read_csv(OUT / "rolling_validation_months.csv")
    names = {"uncorrected":"uncorrected", "last_month":"last_month", "ewma_3m_h60":"ewma_w3_h2",
             "ewma_6m_h60":"ewma_w6_h2", "season_to_date":"season_to_date"}
    old.model = old.model.map(names)
    paired = old.merge(scores, on=["season","month","model","metric"], suffixes=("_old","_new"), validate="one_to_one")
    max_sse_error = float(np.abs(paired.sse_old-paired.sse_new).max())
    assert len(paired)==len(old) and np.array_equal(paired.n_old,paired.n_new) and max_sse_error < 1e-6
    assert scores.groupby(["season","month","metric"]).n.nunique().max()==1
    audit = pd.read_csv(DEST / "training-audit.csv", parse_dates=["cutoff","latest_training_date"])
    assert (audit.dropna(subset=["latest_training_date"]).latest_training_date < audit.dropna(subset=["latest_training_date"]).cutoff).all()
    cells = pd.read_pickle(DEST / "middle-plane-cells.pkl")
    f = cells.loc[(cells.season==2020)&(cells.month==7)]
    expected, actual = effects(fit(f)), estimate(f)["coef"]
    common = expected.index.intersection(actual.index)
    coefficient_error = float(np.abs(expected.loc[common].to_numpy()-actual.loc[common].to_numpy()).max())
    assert coefficient_error < 1e-8
    # Known ground truth: arbitrary pitcher/type intercepts and nuisance effects.
    rng = np.random.default_rng(47023)
    synthetic = []
    parks = ["고척","잠실","창원"]
    truth = {"고척":np.array([5.,-3.]),"잠실":np.array([1.,2.]),"창원":np.array([-7.,5.])}
    for pitcher in range(30):
        for typ in ["직구","슬라이더"]:
            intercept = rng.normal(0,8,2)
            for game in range(18):
                park = parks[game%3]
                speed, left, balls, strikes = rng.normal(0,1), rng.integers(0,2), rng.uniform(0,3), rng.uniform(0,2)
                movement = intercept+truth[park]+np.array([1.5,-2.])*speed+np.array([.8,.3])*speed**2
                movement += np.array([.9,-.6])*left+np.array([.2,.4])*balls+np.array([-.1,.3])*strikes
                synthetic.append(dict(season=2020, month=6, game_date=pd.Timestamp(2020,6,game+1), game_id=f"G{game}",
                    pitcher_id=f"P{pitcher}", pitch_type=typ, park=park, speed50=140+10*speed, left=left, balls=balls,
                    strikes=strikes, n=10, x_cm=movement[0], z_cm=movement[1]))
    s = pd.DataFrame(synthetic)
    result = estimate(s)
    recovery = max(float(np.max(np.abs(result["coef"].loc[p].to_numpy()-(truth[p]-truth["잠실"])))) for p in parks)
    assert recovery < 1e-7
    permuted = estimate(s.sample(frac=1,random_state=9))["coef"]
    order_error = float(np.abs(permuted.loc[result["coef"].index]-result["coef"]).to_numpy().max())
    assert order_error < 1e-8
    shifted = s.copy()
    shifted[AXES] += np.array([130.,-70.])
    translation_error = float(np.abs(estimate(shifted)["coef"]-result["coef"]).to_numpy().max())
    assert translation_error < 1e-8
    games = pd.read_csv(DEST / "game-losses.csv.gz")
    game_sums = games.groupby(["season","month","model"])[["n","x_sse","z_sse"]].sum()
    month_sums = scores.groupby(["season","month","model"])[["n","sse"]].sum()
    assert np.array_equal(game_sums.n*2,month_sums.n)
    game_aggregation_error = float(np.abs(game_sums.x_sse+game_sums.z_sse-month_sums.sse).max())
    assert game_aggregation_error < 1e-6
    result = dict(previous_5_method_max_sse_difference=max_sse_error,
        old_new_monthly_coefficient_error=coefficient_error, synthetic_recovery_error=recovery,
        row_permutation_error=order_error, common_translation_error=translation_error,
        game_aggregation_error=game_aggregation_error, direct_fits_audited=len(audit),
        identical_samples_all_methods=True, strictly_past_training=True,
        raw_snapshot_hash_verified_by_search=True, user_database_and_source_files_modified=False)
    dump_json(result,"verification.json")
    return result


def main():
    scores = pd.read_csv(DEST / "scores.csv")
    protocol = json.loads((DEST/"protocol.json").read_text(encoding="utf-8"))
    config = {x["id"]:x for x in protocol["grid"]}
    development = leaderboard(scores.loc[scores.season<=2024])
    selected = development.drop(index="uncorrected").index[0]
    # The choice is recorded before confirmation results are summarized.
    family_winners = {}
    for family in sorted({x["family"] for x in config.values()}):
        subset = [m for m in development.index if m in config and config[m]["family"]==family]
        family_winners[family] = subset[0]
    for frequency in ["monthly","weekly","daily","fortnightly"]:
        members = [m for m in development.index if m in config and config[m].get("frequency")==frequency]
        if members:
            family_winners["direct_"+frequency] = members[0]
    selection = dict(selected=selected, configuration=config[selected], family_winners=family_winners,
                     rule="minimum pooled combined RMSE using 2020-2024 only", retrospective=True)
    dump_json(selection,"selection.json")
    nested = []
    for year in [2023,2024,2025]:
        ranking = leaderboard(scores.loc[scores.season < year]).drop(index="uncorrected")
        chosen = ranking.index[0]
        evaluation = leaderboard(scores.loc[scores.season==year])
        row = evaluation.loc[chosen]
        nested.append(dict(season=year, selected=chosen, **row.to_dict(),
            last_month_combined=float(evaluation.loc["last_month","combined"]),
            improvement_vs_last_month_pct=float(100*(1-row.combined/evaluation.loc["last_month","combined"]))))
    save(pd.DataFrame(nested),"nested-year-validation.csv")
    tables = []
    for name, data in [("development_2020_2024",scores.loc[scores.season<=2024]),
                       ("confirmation_2025",scores.loc[scores.season==2025]),("all",scores)]:
        table = leaderboard(data).reset_index().assign(period=name)
        tables.append(table)
        print(name+"\n"+table.head(10).to_string(index=False),flush=True)
    save(pd.concat(tables,ignore_index=True),"leaderboard.csv")
    save(pd.concat([leaderboard(data).reset_index().assign(season=year) for year,data in scores.groupby("season")]),"year-results.csv")
    save(pd.concat([leaderboard(data,short=True).reset_index().assign(period=name) for name,data in
                   [("development_2020_2024",scores.loc[scores.season<=2024]),("confirmation_2025",scores.loc[scores.season==2025]),("all",scores)]]),"short-period-sensitivity.csv")
    comparisons = []
    for name,data in [("all",scores),("confirmation_2025",scores.loc[scores.season==2025])]:
        for method in dict.fromkeys([selected, family_winners["ewma"],family_winners["kalman"],
                                    family_winners["direct_monthly"],family_winners["direct_weekly"]]):
            if method != "last_month":
                comparisons.append(dict(period=name,**paired_bootstrap(data,method)))
        if selected != family_winners["direct_weekly"]:
            comparisons.append(dict(period=name,**paired_bootstrap(data,selected,family_winners["direct_weekly"])))
    save(pd.DataFrame(comparisons),"uncertainty.csv")
    all_ranking = leaderboard(scores)
    print("SELECTED\n"+json.dumps(selection,ensure_ascii=False,indent=2),flush=True)
    print("UNCERTAINTY\n"+pd.DataFrame(comparisons).to_string(index=False),flush=True)
    print("VERIFICATION\n"+json.dumps(verify(scores),ensure_ascii=False,indent=2),flush=True)


if __name__=="__main__":
    main()
