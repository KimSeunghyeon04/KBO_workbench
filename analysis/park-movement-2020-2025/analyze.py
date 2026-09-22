"""Exploratory statistical analysis of sealed pitch facts, not a game compiler.

Run after extract.py. Uses only exported files; no database writes or app changes.
"""

from pathlib import Path
import hashlib
import json
import sys

import numpy as np
import pandas as pd
from scipy import stats

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(__file__).resolve().parent
METRICS = ["x_cm", "z_cm", "depth_cm", "arrival_ms"]


def save(frame, name):
    frame.to_csv(OUT / name, index=False, encoding="utf-8-sig")


def prepare():
    snapshot = json.loads((OUT / "snapshot.json").read_text())
    raw = pd.read_csv(snapshot["raw_cache"], dtype={"pitcher_id": "str"})
    manifest = pd.read_csv(OUT / "manifest.csv", parse_dates=["game_date"])
    assert len(raw) == snapshot["actual_pitches"]
    assert not raw.duplicated(["game_id", "revision", "pitch_sequence"]).any()
    d = raw.merge(manifest, on=["game_id", "revision"], validate="many_to_one")
    d["park"] = d["stadium"]
    d.loc[(d.season == 2025) & d.stadium.isin(["대전", "대전(신)"]), "park"] = "대전신"
    d.loc[(d.season < 2025) & (d.stadium == "대전"), "park"] = "대전구"
    d["month"] = d.game_date.dt.month
    d["period"] = ((d.game_date.dt.dayofyear - 1) // 28).astype(str)
    d["fold"] = d.game_id.map(lambda g: int(hashlib.sha256(g.encode()).hexdigest()[:8], 16) % 5)
    cols = ["x0", "y0", "z0", "vx0", "vy0", "vz0", "ax", "ay", "az", "cross_plate_y"]
    complete = np.isfinite(d[cols].to_numpy()).all(axis=1)
    with np.errstate(all="ignore"):
        distance = d.y0 - d.cross_plate_y
        disc = d.vy0**2 - 2 * d.ay * distance
        time = 2 * distance / (-d.vy0 + np.sqrt(disc))
        height = d.z0 + d.vz0 * time + d.az * time**2 / 2
        valid = (complete & (d.measurement_profile_id == "naver_pts_v1")
                 & ((d.y0 - 50).abs() <= 1e-6) & (d.z0 >= 0)
                 & (d.cross_plate_y >= 0) & (d.cross_plate_y < d.y0)
                 & (d.vy0 < 0) & (disc >= 0) & (time > 0)
                 & np.isfinite(time) & ((d.vy0 + d.ay * time) < 0)
                 & (height >= 0) & np.isfinite(height))
        d["kx"] = d.ax - d.vx0 / d.vy0 * d.ay
        d["kz"] = d.az - d.vz0 / d.vy0 * d.ay
        d["speed50"] = np.sqrt(d.vx0**2 + d.vy0**2 + d.vz0**2) * 1.09728
        d["arrival_ms"] = time * 1000
        valid &= np.isfinite(d[["kx", "kz", "speed50"]].to_numpy()).all(axis=1)
    d["valid"] = valid
    coverage = d.groupby("season").agg(actual=("game_id", "size"),
        linked=("tracking_id", "count"), valid=("valid", "sum"), games=("game_id", "nunique"))
    coverage["manifest_games"] = manifest.groupby("season").size()
    coverage["valid_pct"] = coverage.valid / coverage.actual * 100
    save(coverage.reset_index(), "coverage.csv")
    save(d.groupby(["season", "park"]).agg(actual=("game_id", "size"),
        linked=("tracking_id", "count"), valid=("valid", "sum"),
        games=("game_id", "nunique")).reset_index(), "park_coverage.csv")
    save(d.groupby(["season", "cross_plate_y"], dropna=False).size().rename("pitches").reset_index(),
         "plate_reference_coverage.csv")
    save(d.loc[~valid].groupby(["season", "park", "measurement_profile_id"], dropna=False)
         .size().rename("pitches").reset_index(), "excluded.csv")
    d = d.loc[valid].copy()
    refs = []
    for season, frame in d.groupby("season"):
        ff = frame.loc[frame.pitch_type == "직구"]
        dist = (ff.y0 - ff.cross_plate_y).mean()
        vy, ay = ff.vy0.mean(), ff.ay.mean()
        t = 2 * dist / (-vy + np.sqrt(vy**2 - 2 * ay * dist))
        kx, kz = ff.kx.mean(), ff.kz.mean()
        idx = frame.index
        d.loc[idx, "x_cm"] = (frame.kx - kx) * t**2 / 2 * 30.48
        d.loc[idx, "z_cm"] = (frame.kz - kz) * t**2 / 2 * 30.48
        d.loc[idx, "depth_cm"] = ((frame.y0-frame.cross_plate_y)+frame.vy0*t+frame.ay*t**2/2)*30.48
        refs.append(dict(season=int(season), ff_pitches=len(ff), T=t, kx=kx, kz=kz))
    save(pd.DataFrame(refs), "references.csv")
    # Independent check against the public, existing game-core trajectory API.
    sample = d.iloc[np.linspace(0, len(d)-1, 1000).astype(int)]
    verification = []
    for row in sample.itertuples():
        item = {k: float(getattr(row, k)) for k in cols if k != "cross_plate_y"}
        item["crossPlateY"] = row.cross_plate_y
        verification.append(dict(input=item, expected=[row.kx, row.kz, row.speed50, row.arrival_ms/1000]))
    (OUT / "verification-input.json").write_text(json.dumps(verification), encoding="utf-8")
    save(d.groupby(["season", "park"]).agg(
        n=("game_id", "size"), x_cm=("x_cm", "mean"), z_cm=("z_cm", "mean")).reset_index(), "raw_means.csv")
    print("COVERAGE\n" + coverage.to_string(), flush=True)
    print("VALID QUANTILES\n" + d[METRICS].quantile([0, .001, .01, .5, .99, .999, 1]).to_string(), flush=True)
    d["left"] = (d.stance == "L").astype(float)
    keys = ["season", "game_id", "game_date", "park", "stadium", "pitcher_id", "pitch_type", "half", "month", "period", "fold"]
    aggs = {metric: (metric, "mean") for metric in METRICS}
    aggs.update(n=("game_id", "size"), left=("left", "mean"), speed50=("speed50", "mean"),
                balls=("before_balls", "mean"), strikes=("before_strikes", "mean"),
                speed_kph=("speed_kph", "mean"))
    a = d.dropna(subset=["pitch_type"]).groupby(keys).agg(**aggs).reset_index()
    save(a, "pitcher_game_type.csv.gz")
    return a


def group_means(values, codes, weights, groups):
    denominator = np.bincount(codes, weights=weights, minlength=groups)
    answer = np.empty((groups, values.shape[1]))
    for j in range(values.shape[1]):
        answer[:, j] = np.bincount(codes, weights=weights*values[:, j], minlength=groups)/denominator
    return answer


def design(frame, parks, types, with_park=True):
    pieces = []
    if with_park:
        # Last park omitted; coefficients are subsequently centered to zero mean.
        pieces.extend([(frame.park == p).to_numpy(float) for p in parks[:-1]])
    speed = (frame.speed50.to_numpy() - 140)/10
    for typ in types:
        mask = (frame.pitch_type == typ).to_numpy(float)
        pieces.extend([mask*speed, mask*speed**2])
    pieces.extend([frame.left.to_numpy(), frame.balls.to_numpy(), frame.strikes.to_numpy()])
    return np.column_stack(pieces)


def fit(frame, group="month", weighted=True, with_park=True, support=True):
    f = frame.copy()
    f["fe"] = f.pitcher_id + "|" + f.pitch_type
    if group != "season":
        f["fe"] += "|" + f[group].astype(str)
    if support:
        eligible = f.groupby("fe").park.nunique()
        f = f.loc[f.fe.isin(eligible[eligible >= 2].index)].copy()
    if len(f) < 100:
        return None
    parks = sorted(f.park.unique())
    types = sorted(f.pitch_type.unique())
    codes, groups = pd.factorize(f.fe, sort=True)
    weights = np.minimum(f.n.to_numpy(), 30).astype(float) if weighted else np.ones(len(f))
    x = design(f, parks, types, with_park)
    y = f[METRICS].to_numpy()
    xm = group_means(x, codes, weights, len(groups))
    ym = group_means(y, codes, weights, len(groups))
    xd, yd = x-xm[codes], y-ym[codes]
    normal = xd.T @ (weights[:, None]*xd)
    bread = np.linalg.pinv(normal, rcond=1e-11)
    beta = bread @ (xd.T @ (weights[:, None]*yd))
    residual = yd - xd @ beta
    alpha = ym-xm@beta
    # Two-way cluster covariance: pitcher + game - pitcher/game intersection.
    nobs, nparam = len(f), len(groups)+np.linalg.matrix_rank(normal)
    cov = np.zeros((len(METRICS), x.shape[1], x.shape[1]))
    ngroups = []
    for cluster, sign in [(f.pitcher_id, 1), (f.game_id, 1), (f.pitcher_id+"|"+f.game_id, -1)]:
        cl, un = pd.factorize(cluster, sort=True)
        ngroups.append(len(un))
        factor = len(un)/(len(un)-1) * (nobs-1)/max(1, nobs-nparam)
        for j in range(len(METRICS)):
            scores = np.zeros((len(un), x.shape[1]))
            np.add.at(scores, cl, xd*(weights*residual[:, j])[:, None])
            cov[j] += sign*factor*(bread @ (scores.T@scores) @ bread)
    park_weights = f.groupby("park").n.sum().reindex(parks).to_numpy(float)
    park_weights /= park_weights.sum()
    transform = np.zeros((len(parks), x.shape[1]))
    if with_park:
        transform[:len(parks)-1, :len(parks)-1] = np.eye(len(parks)-1)
        transform -= park_weights @ transform
    offsets = transform@beta
    variance = np.column_stack([np.einsum("ij,jk,ik->i", transform, c, transform) for c in cov])
    se = np.sqrt(np.maximum(variance, 0))
    crit = stats.t.ppf(.975, min(ngroups[:2])-1)
    counts = f.groupby("park").agg(rows=("n", "size"), pitches=("n", "sum"),
        games=("game_id", "nunique"), pitchers=("pitcher_id", "nunique")).reindex(parks)
    output = []
    for i, park in enumerate(parks):
        row = dict(season=int(f.season.iloc[0]), park=park, ci_df=min(ngroups[:2])-1, **counts.loc[park].to_dict())
        for j, metric in enumerate(METRICS):
            row.update({metric: offsets[i, j], metric+"_se": se[i, j],
                        metric+"_low": offsets[i, j]-crit*se[i, j],
                        metric+"_high": offsets[i, j]+crit*se[i, j]})
        output.append(row)
    return dict(f=f, parks=parks, types=types, beta=beta, alpha=pd.DataFrame(alpha,index=groups),
        output=pd.DataFrame(output), with_park=with_park, group=group, weighted=weighted,
        rank=int(np.linalg.matrix_rank(normal)), columns=x.shape[1])


def predict(model, test):
    f = test.copy()
    f["fe"] = f.pitcher_id+"|"+f.pitch_type
    if model["group"] != "season":
        f["fe"] += "|"+f[model["group"]].astype(str)
    eligible = (f.fe.isin(model["alpha"].index) & f.park.isin(model["parks"])
                & f.pitch_type.isin(model["types"]))
    f = f.loc[eligible]
    x = design(f, model["parks"], model["types"], model["with_park"])
    predicted = model["alpha"].loc[f.fe].to_numpy()+x@model["beta"]
    return f.index, predicted


def validate(frame, season, scheme="game"):
    results = []
    for fold in range(5):
        train = frame.loc[frame.fold != fold]
        test = frame.loc[frame.fold == fold]
        # Support selection uses training data only, for both nested models.
        full = fit(train)
        base = fit(full["f"], with_park=False)
        ix, pred = predict(full, test)
        ib, pred0 = predict(base, test)
        assert np.array_equal(ix, ib)
        target = test.loc[ix, METRICS].to_numpy()
        for j, metric in enumerate(METRICS):
            results.append(dict(season=season, fold=fold, metric=metric, n=len(ix),
                raw_sse=float(np.sum((target[:, j]-pred0[:, j])**2)),
                corrected_sse=float(np.sum((target[:, j]-pred[:, j])**2))))
    return results


def main():
    # Rebuild from the identified snapshot so a new extraction cannot reuse stale aggregates.
    a = prepare()
    a = a.loc[a.n >= 5].copy()
    results, cv, model_counts = [], [], []
    sensitivity = []
    for season, frame in a.groupby("season"):
        fitted = fit(frame)
        results.append(fitted["output"])
        model_counts.append(dict(season=int(season), rows=len(fitted["f"]),
            pitches=int(fitted["f"].n.sum()), games=fitted["f"].game_id.nunique(),
            pitchers=fitted["f"].pitcher_id.nunique(), fe_groups=fitted["f"].fe.nunique(),
            rank=fitted["rank"], columns=fitted["columns"]))
        print(f"SEASON {season}\n"+fitted["output"][["park","pitches","x_cm","z_cm"]].to_string(index=False), flush=True)
        variants = [("season_fe", frame, "season", True),
                    ("28day_fe", frame, "period", True),
                    ("away_only", frame.loc[frame.half=="bottom"], "month", True),
                    ("fastball_only", frame.loc[frame.pitch_type=="직구"], "month", True),
                    ("equal_cells", frame, "month", False),
                    ("original_labels", frame.assign(park=frame.stadium), "month", True)]
        for name, subset, group, weighted in variants:
            model = fit(subset, group=group, weighted=weighted)
            if model is not None:
                sensitivity.append(model["output"].assign(variant=name))
        cv.extend(validate(frame, int(season)))
        print(f"SEASON {season} cross-validation complete", flush=True)
    all_results = pd.concat(results, ignore_index=True)
    # BH across all park/year/axis estimates, exploratory simultaneous screening.
    pvals = []
    for metric in ["x_cm", "z_cm"]:
        pvals.extend(2*stats.t.sf(np.abs(all_results[metric]/all_results[metric+"_se"]), all_results.ci_df))
    pvals = np.asarray(pvals)
    order = np.argsort(pvals)
    q = np.empty(len(pvals))
    q[order] = np.minimum(1, np.minimum.accumulate((pvals[order]*len(pvals)/np.arange(1,len(pvals)+1))[::-1])[::-1])
    for i, metric in enumerate(["x_cm", "z_cm"]):
        all_results[metric+"_q"] = q[i*len(all_results):(i+1)*len(all_results)]
    save(all_results, "park_effects.csv")
    save(pd.concat(sensitivity, ignore_index=True), "sensitivity.csv")
    save(pd.DataFrame(cv), "cross_validation.csv")
    save(pd.DataFrame(model_counts), "model_counts.csv")
    score = pd.DataFrame(cv).groupby(["season", "metric"])[["n","raw_sse","corrected_sse"]].sum()
    score["raw_rmse"] = np.sqrt(score.raw_sse/score.n)
    score["corrected_rmse"] = np.sqrt(score.corrected_sse/score.n)
    score["rmse_reduction_pct"] = (1-score.corrected_rmse/score.raw_rmse)*100
    save(score.reset_index(), "validation_summary.csv")
    print(score.to_string(), flush=True)


if __name__ == "__main__":
    main()
