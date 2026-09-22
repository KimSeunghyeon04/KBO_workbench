"""Time stability and out-of-pitcher validation for the exploratory model."""

import numpy as np
import pandas as pd
from analyze import OUT, METRICS, fit, design, group_means, save

a = pd.read_csv(OUT / "pitcher_game_type.csv.gz", dtype={"pitcher_id":"str", "period":"str"})
a = a.loc[a.n >= 5].copy()
monthly, oof, bytype = [], [], []
for season, frame in a.groupby("season"):
    for month, subset in frame.groupby("month"):
        model = fit(subset)
        if model is not None and model["rank"] == model["columns"]:
            monthly.append(model["output"].assign(month=month))
    for typ, subset in frame.groupby("pitch_type"):
        if subset.n.sum() < 3000:
            continue
        model = fit(subset)
        if model is not None and model["rank"] == model["columns"]:
            bytype.append(model["output"].assign(pitch_type=typ))
    # Estimate correction on other pitchers; test it on unseen pitchers' within-FE differences.
    import hashlib
    folds = frame.pitcher_id.map(lambda p: int(hashlib.sha256(p.encode()).hexdigest()[:8],16)%5)
    for fold in range(5):
        train, test = frame.loc[folds != fold], frame.loc[folds == fold].copy()
        full = fit(train)
        base = fit(full["f"], with_park=False)
        test["fe"] = test.pitcher_id+"|"+test.pitch_type+"|"+test.month.astype(str)
        test = test.loc[test.park.isin(full["parks"]) & test.pitch_type.isin(full["types"])]
        support = test.groupby("fe").park.nunique()
        test = test.loc[test.fe.isin(support[support >= 2].index)]
        codes, groups = pd.factorize(test.fe, sort=True)
        weights = np.minimum(test.n.to_numpy(),30)
        y = test[METRICS].to_numpy()
        yd = y-group_means(y,codes,weights,len(groups))[codes]
        residuals = []
        for model in [base, full]:
            x = design(test, model["parks"], model["types"], model["with_park"])
            xd = x-group_means(x,codes,weights,len(groups))[codes]
            residuals.append(yd-xd@model["beta"])
        for j, metric in enumerate(METRICS):
            oof.append(dict(season=season,fold=fold,metric=metric,n=len(test),
                raw_sse=np.sum(residuals[0][:,j]**2),corrected_sse=np.sum(residuals[1][:,j]**2)))
    print(f"diagnostics {season} complete", flush=True)
save(pd.concat(monthly), "monthly_effects.csv")
save(pd.concat(bytype), "pitch_type_effects.csv")
save(pd.DataFrame(oof), "pitcher_holdout.csv")
score = pd.DataFrame(oof).groupby(["season","metric"])[["n","raw_sse","corrected_sse"]].sum()
score["raw_rmse"] = np.sqrt(score.raw_sse/score.n)
score["corrected_rmse"] = np.sqrt(score.corrected_sse/score.n)
score["rmse_reduction_pct"] = (1-score.corrected_rmse/score.raw_rmse)*100
save(score.reset_index(), "pitcher_holdout_summary.csv")
print(score.to_string(),flush=True)
