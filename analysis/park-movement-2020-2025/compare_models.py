"""Compare annual, monthly and pitch-type offsets on common unseen-game cells."""

import numpy as np
import pandas as pd
from analyze import OUT, METRICS, fit, predict, save

a = pd.read_csv(OUT / "pitcher_game_type.csv.gz", dtype={"pitcher_id":"str", "period":"str"})
a = a.loc[a.n >= 5].copy()
scores = []
for season, frame in a.groupby("season"):
    for fold in range(5):
        train, test = frame.loc[frame.fold != fold], frame.loc[frame.fold == fold]
        annual = fit(train)
        base = fit(annual["f"], with_park=False)
        predictions = {}
        for name, model in [("baseline",base),("annual",annual)]:
            idx, pred = predict(model,test)
            predictions[name] = pd.DataFrame(pred,index=idx,columns=METRICS)
        for name, key in [("monthly","month"),("pitch_type","pitch_type")]:
            parts = []
            for value, subset in train.groupby(key):
                model = fit(subset)
                if model is None or model["rank"] != model["columns"]:
                    continue
                idx, pred = predict(model,test.loc[test[key]==value])
                parts.append(pd.DataFrame(pred,index=idx,columns=METRICS))
            predictions[name] = pd.concat(parts)
        common = predictions["baseline"].index
        for pred in predictions.values():
            common = common.intersection(pred.index)
        target = test.loc[common,METRICS].to_numpy()
        for name, pred in predictions.items():
            err = pred.loc[common].to_numpy()-target
            for j,metric in enumerate(METRICS):
                scores.append(dict(season=season,fold=fold,model=name,metric=metric,
                    n=len(common),sse=float(np.sum(err[:,j]**2))))
    print(f"model comparison {season} complete",flush=True)
save(pd.DataFrame(scores),"model_comparison_folds.csv")
s = pd.DataFrame(scores).groupby(["season","model","metric"])[["n","sse"]].sum()
s["rmse"] = np.sqrt(s.sse/s.n)
save(s.reset_index(),"model_comparison.csv")
print(s.loc[(slice(None),slice(None),["x_cm","z_cm"]),:].to_string(),flush=True)
