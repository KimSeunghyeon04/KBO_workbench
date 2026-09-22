"""Independent replay of selected forecasts and sensitivity summaries."""

import json
import numpy as np
import pandas as pd

from analyze import design, fit, group_means
from calibration_search import DEST, AXES, save, dump_json


def main():
    chosen = json.loads((DEST/"selection.json").read_text(encoding="utf-8"))["selected"]
    cells = pd.read_pickle(DEST/"middle-plane-cells.pkl")
    coverage = pd.read_csv(DEST/"coverage.csv")
    forecasts = json.loads((DEST/"coefficient-checkpoints.json").read_text(encoding="utf-8"))
    forecast_lookup = {}
    for row in forecasts:
        if row["model"] in [chosen,"last_month"]:
            forecast_lookup.setdefault((row["season"],row["month"],row["model"]),{})[row["cutoff"]] = row["coef"]
    methods = ["uncorrected","last_month",chosen]
    results, detailed = [], []
    for key in coverage.itertuples():
        season,month = key.season,key.month
        cutoff = pd.Timestamp(season,month,1)
        before = cells.loc[(cells.season==season)&(cells.game_date<cutoff)]
        model = fit(before)
        test = cells.loc[(cells.season==season)&(cells.month==month)].copy()
        baseline_map = forecast_lookup[(season,month,"last_month")][str(cutoff.date())]
        # Recover exact previous comparison support from its month-specific output.
        old_month = pd.read_csv(DEST.parent/"rolling_monthly_history.csv")
        eligible = set(old_month.loc[(old_month.season==season)&(old_month.month==month-1),"park"]).intersection(baseline_map)
        test = test.loc[test.park.isin(eligible)&test.pitch_type.isin(model["types"])].copy()
        test["fe"] = test.pitcher_id+"|"+test.pitch_type
        groups = test.groupby("fe").park.nunique()
        test = test.loc[test.fe.isin(groups[groups>=2].index)].copy()
        assert len(test)==key.rows
        x = design(test,model["parks"],model["types"])
        x[:,:len(model["parks"])-1] = 0
        y = test[AXES].to_numpy()-(x@model["beta"])[:,:2]
        codes,names = pd.factorize(test.fe,sort=True)
        for method in methods:
            offsets = np.zeros((len(test),2))
            if method!="uncorrected":
                lookup = forecast_lookup[(season,month,method)]
                dates = sorted(lookup)
                for i,row in enumerate(test.itertuples()):
                    available = [d for d in dates if pd.Timestamp(d)<=row.game_date]
                    assert available
                    value = lookup[available[-1]][row.park]
                    offsets[i] = [value[axis] for axis in AXES]
            initial = y-offsets
            for weighting,w in [("capped_pitch_count",np.minimum(test.n.to_numpy(),30)),("equal_cell",np.ones(len(test)))]:
                residual = initial-group_means(initial,codes,w,len(names))[codes]
                for j,axis in enumerate(AXES):
                    results.append(dict(season=season,month=month,model=method,centering=weighting,metric=axis,
                        n=len(test),sse=float(np.sum(residual[:,j]**2))))
                if weighting=="capped_pitch_count":
                    detail = test[["season","month","game_id","park","pitch_type","pitcher_id","n"]].copy()
                    detail[AXES] = residual
                    detail["model"] = method
                    detailed.append(detail)
    save(pd.DataFrame(results),"independent-replay-sensitivity.csv")
    detail = pd.concat(detailed,ignore_index=True)
    save(detail,"selected-residuals.csv.gz")
    tails=[]
    for (season,method),f in detail.groupby(["season","model"]):
        for axis in AXES:
            v=np.abs(f[axis].to_numpy())
            tails.append(dict(season=season,model=method,metric=axis,median_absolute=float(np.median(v)),
                p90_absolute=float(np.quantile(v,.9)),p95_absolute=float(np.quantile(v,.95)),
                trimmed_rmse=float(np.sqrt(np.mean(np.minimum(v,np.quantile(v,.95))**2)))))
    save(pd.DataFrame(tails),"residual-distribution.csv")
    games=pd.read_csv(DEST/"game-losses.csv.gz")
    games["mse"]=(games.x_sse+games.z_sse)/(2*games.n)
    eq=games.groupby(["season","model"]).mse.mean().pow(.5).rename("equal_game_rmse").reset_index()
    save(eq,"equal-game-sensitivity.csv")
    original=pd.read_csv(DEST/"scores.csv")
    original=original.loc[original.model.isin(methods)]
    replay=pd.DataFrame(results)
    replay=replay.loc[replay.centering=="capped_pitch_count"]
    paired=original.merge(replay,on=["season","month","model","metric"],suffixes=("_orig","_replay"),validate="one_to_one")
    err=float(np.abs(paired.sse_orig-paired.sse_replay).max())
    assert len(paired)==len(original) and err<1e-6
    dump_json(dict(selected=chosen,independent_forecast_replay_sse_error=err,coefficient_dates_checked=True),"replay-verification.json")
    print(json.dumps(dict(selected=chosen,replay_error=err),ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
