"""Explore monthly calibration using past data only; no app or database writes.

All pitches are validated at y=17/24 ft. Curvature coefficients are converted
to cm at a fixed 0.4-second diagnostic clock, so averaging does not mix season
reference clocks. This diagnostic is not a replacement production trajectory API.
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from analyze import OUT, METRICS, design, fit, group_means, save

PLANE = 17 / 24
DISPLAY_TIME = .4
SCALE = .5 * DISPLAY_TIME**2 * 30.48
MAIN = ["고척", "광주", "대구", "대전구", "대전신", "문학", "사직", "수원", "잠실", "창원"]
METHODS = ["uncorrected", "last_month", "ewma_3m_h60", "ewma_6m_h60", "season_to_date"]


def prepare():
    snapshot = json.loads((OUT / "snapshot.json").read_text())
    d = pd.read_csv(snapshot["raw_cache"], dtype={"pitcher_id": "str"})
    manifest = pd.read_csv(OUT / "manifest.csv", parse_dates=["game_date"])
    d = d.merge(manifest, on=["game_id", "revision"], validate="many_to_one")
    d["park"] = d.stadium
    d.loc[(d.season == 2025) & d.stadium.isin(["대전", "대전(신)"]), "park"] = "대전신"
    d.loc[(d.season < 2025) & (d.stadium == "대전"), "park"] = "대전구"
    fields = ["x0","y0","z0","vx0","vy0","vz0","ax","ay","az"]
    with np.errstate(all="ignore"):
        dist = d.y0 - PLANE
        disc = d.vy0**2-2*d.ay*dist
        t = 2*dist/(-d.vy0+np.sqrt(disc))
        z = d.z0+d.vz0*t+d.az*t*t/2
        valid = (np.isfinite(d[fields].to_numpy()).all(axis=1)
            & (d.measurement_profile_id == "naver_pts_v1") & ((d.y0-50).abs() <= 1e-6)
            & (d.z0 >= 0) & (d.vy0 < 0) & (disc >= 0) & (t > 0) & np.isfinite(t)
            & ((d.vy0+d.ay*t) < 0) & (z >= 0) & np.isfinite(z))
        d["x_cm"] = (d.ax-d.vx0/d.vy0*d.ay)*SCALE
        d["z_cm"] = (d.az-d.vz0/d.vy0*d.ay)*SCALE
        d["speed50"] = np.sqrt(d.vx0**2+d.vy0**2+d.vz0**2)*1.09728
        d["arrival_ms"] = t*1000
        d["depth_cm"] = (dist+d.vy0*DISPLAY_TIME+d.ay*DISPLAY_TIME**2/2)*30.48
        valid &= np.isfinite(d[METRICS+["speed50"]].to_numpy()).all(axis=1)
    d = d.loc[valid & d.park.isin(MAIN) & d.pitch_type.notna()].copy()
    d["month"] = d.game_date.dt.month
    d["left"] = (d.stance == "L").astype(float)
    keys = ["season","month","game_id","game_date","park","pitcher_id","pitch_type"]
    aggs = {k:(k,"mean") for k in METRICS+["speed50","left"]}
    aggs.update(n=("game_id","size"),balls=("before_balls","mean"),strikes=("before_strikes","mean"))
    a = d.groupby(keys).agg(**aggs).reset_index()
    return a.loc[a.n >= 5].copy()


def effects(model):
    o = model["output"].set_index("park")
    if "잠실" not in o.index:
        return None
    # Constant anchor prevents monthly zero points from drifting with pitch mix.
    # This is an identifiable relative contrast, not an assumption of true zero bias.
    result = o[["x_cm","z_cm"]] - o.loc["잠실",["x_cm","z_cm"]]
    return result.loc[(o.games >= 5) & (o.pitchers >= 20)]


def main():
    a = prepare()
    all_scores, histories, coverage = [], [], []
    for season, season_frame in a.groupby("season"):
        history = {}
        for month, frame in season_frame.groupby("month"):
            prior = season_frame.loc[season_frame.month < month]
            if len(history) >= 2 and 5 <= month <= 9:
                model = fit(prior)
                current = effects(model) if model is not None else None
                candidates = {}
                if current is not None:
                    candidates["season_to_date"] = current
                if month-1 in history:
                    candidates["last_month"] = history[month-1]
                for label, window in [("ewma_3m_h60",3),("ewma_6m_h60",6)]:
                    pieces = []
                    for past_month, eff in history.items():
                        if 1 <= month-past_month <= window:
                            # 60.875 days = two mean calendar months; completed-month midpoint ages.
                            weight = 2**(-(month-past_month-1)/2)
                            f = eff.copy()
                            f["weight"] = weight
                            pieces.append(f.reset_index())
                    if pieces:
                        combined = pd.concat(pieces)
                        for k in ["x_cm","z_cm"]:
                            combined[k] *= combined.weight
                        summed = combined.groupby("park")[["x_cm","z_cm","weight"]].sum()
                        candidates[label] = summed[["x_cm","z_cm"]].div(summed.weight,axis=0)
                if len(candidates) == 4:
                    parks = set.intersection(*(set(c.index) for c in candidates.values()))
                    test = frame.loc[frame.park.isin(parks) & frame.pitch_type.isin(model["types"])].copy()
                    test["fe"] = test.pitcher_id+"|"+test.pitch_type
                    support = test.groupby("fe").park.nunique()
                    test = test.loc[test.fe.isin(support[support >= 2].index)]
                    if len(test) >= 100:
                        codes, groups = pd.factorize(test.fe,sort=True)
                        w = np.minimum(test.n.to_numpy(),30)
                        x = design(test,model["parks"],model["types"])
                        x[:,:len(model["parks"])-1] = 0
                        # Same past-estimated speed/stance/count adjustment for every candidate.
                        y = test[["x_cm","z_cm"]].to_numpy()-(x@model["beta"])[:,:2]
                        candidates["uncorrected"] = pd.DataFrame(0.,index=sorted(parks),columns=["x_cm","z_cm"])
                        for label, offsets in candidates.items():
                            residual = y-offsets.loc[test.park].to_numpy()
                            residual -= group_means(residual,codes,w,len(groups))[codes]
                            for j,metric in enumerate(["x_cm","z_cm"]):
                                all_scores.append(dict(season=season,month=month,model=label,metric=metric,
                                    n=len(test),sse=float(np.sum(residual[:,j]**2))))
                        coverage.append(dict(season=season,month=month,rows=len(test),
                            games=test.game_id.nunique(),pitchers=test.pitcher_id.nunique(),parks=len(parks),
                            last_training_date=str(prior.game_date.max().date()),
                            first_test_date=str(test.game_date.min().date())))
                        assert prior.game_date.max() < test.game_date.min()
            fitted = fit(frame)
            if fitted is not None:
                value = effects(fitted)
                if value is not None and len(value) >= 5:
                    history[int(month)] = value
                    histories.append(value.reset_index().assign(season=season,month=month))
        print(f"rolling calibration {season} complete",flush=True)
    save(pd.concat(histories),"rolling_monthly_history.csv")
    save(pd.DataFrame(coverage),"rolling_validation_coverage.csv")
    scores = pd.DataFrame(all_scores)
    save(scores,"rolling_validation_months.csv")
    summary = scores.groupby(["season","model","metric"])[["n","sse"]].sum()
    summary["rmse_cm_at_400ms"] = np.sqrt(summary.sse/summary.n)
    save(summary.reset_index(),"rolling_validation_summary.csv")
    print(summary.to_string(),flush=True)
    pooled = scores.groupby(["model","metric"])[["n","sse"]].sum()
    pooled["rmse_cm_at_400ms"] = np.sqrt(pooled.sse/pooled.n)
    save(pooled.reset_index(),"rolling_validation_pooled.csv")
    print("POOLED\n"+pooled.to_string(),flush=True)


if __name__ == "__main__":
    main()
