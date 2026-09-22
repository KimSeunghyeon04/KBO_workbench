"""Offline, past-only comparison of automatic park calibration policies.

Reads the existing immutable extract. Writes research artifacts only. The
candidate grid is serialized before fitting; 2025 does not select parameters.
"""

import os
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

from pathlib import Path
import hashlib
import gzip
import json
import sys
import time

import numpy as np
import pandas as pd

from analyze import OUT, design, fit, group_means
from rolling_calibration import prepare, effects, SCALE, MAIN

sys.stdout.reconfigure(encoding="utf-8")
DEST = OUT / "calibration-search"
AXES = ["x_cm", "z_cm"]
ANCHOR = "잠실"


def dump_json(value, filename):
    (DEST / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def save(frame, filename):
    frame.to_csv(DEST / filename, index=False, encoding="utf-8-sig")


def configurations():
    result = [dict(id="last_month", family="latest"),
              dict(id="season_to_date", family="pooled")]
    for window in [2, 3, 6]:
        for half in [.25, .5, 1., 2., 3.]:
            result.append(dict(id=f"ewma_w{window}_h{half:g}", family="ewma", window=window, half=half))
    for half in [.5, 1., 2.]:
        for drift in [.25, 1., 2.]:
            result.append(dict(id=f"precision_h{half:g}_q{drift:g}", family="precision", half=half, drift=drift))
    for alpha in [.5, .75, .9]:
        result.append(dict(id=f"ema_a{alpha:g}", family="ema", alpha=alpha))
    for drift in [.25, .5, 1., 2., 4.]:
        result.append(dict(id=f"kalman_q{drift:g}", family="kalman", drift=drift, adaptive=False))
    for drift in [.5, 1., 2.]:
        result.append(dict(id=f"adaptive_q{drift:g}", family="kalman", drift=drift, adaptive=True))
    for damp in [.25, .5]:
        result.append(dict(id=f"trend_d{damp:g}", family="trend", damp=damp))
    for frequency in ["monthly", "weekly"]:
        for window in [28, 56, 84]:
            for half in [None, 14, 28]:
                result.append(dict(id=f"{frequency}_w{window}_h{half or 'flat'}", family="direct",
                                   frequency=frequency, window=window, half=half, robust=False))
            result.append(dict(id=f"{frequency}_w{window}_h28_huber", family="direct",
                               frequency=frequency, window=window, half=28, robust=True))
    # Boundary check after the initial <=2024 winner used the longest window
    # and shortest direct-fit half-life in that first grid.
    if "--extended" in sys.argv:
        additional = [("weekly", w, h, False) for w in [56,84,112] for h in [7,10,21]]
        additional += [("weekly",112,14,False),("weekly",84,3.5,False),("weekly",28,7,False),
                       ("weekly",84,14,True),("daily",84,3.5,False)]
        additional += [("daily",w,h,False) for w in [56,84] for h in [7,14,28]]
        additional += [("fortnightly",84,h,False) for h in [7,14,28]]
        for frequency, window, half, robust in additional:
            result.append(dict(id=f"{frequency}_w{window}_h{half:g}"+("_huber" if robust else ""), family="direct",
                               frequency=frequency, window=window, half=half, robust=robust))
    return result


def psd(matrix, floor=.04):
    values, vectors = np.linalg.eigh((matrix + matrix.T) / 2)
    return (vectors * np.maximum(values, floor)) @ vectors.T


def connected_frame(frame):
    """Only park contrasts in the anchor's observed comparison network exist."""
    f = frame.copy()
    f["fe"] = f.pitcher_id + "|" + f.pitch_type + "|" + f.month.astype(str)
    support = f.groupby("fe").park.nunique()
    f = f.loc[f.fe.isin(support[support >= 2].index)].copy()
    component = {ANCHOR}
    edges = f.groupby("fe").park.unique().tolist()
    for _ in range(len(MAIN)):
        before = len(component)
        for edge in edges:
            if component.intersection(edge):
                component.update(edge)
        if len(component) == before:
            break
    return f.loc[f.park.isin(component)].copy()


def estimate(frame, cutoff=None, half=None, robust=False, covariance=True):
    f = connected_frame(frame)
    if len(f) < 100 or ANCHOR not in set(f.park):
        return None
    parks, types = sorted(f.park.unique()), sorted(f.pitch_type.unique())
    if len(parks) < 3:
        return None
    x, y = design(f, parks, types), f[AXES].to_numpy()
    codes, groups = pd.factorize(f.fe, sort=True)
    base_w = np.minimum(f.n.to_numpy(float), 30)
    if half is not None:
        age = (cutoff - f.game_date).dt.days.to_numpy()
        assert np.min(age) > 0
        base_w *= 2. ** (-age / half)
    robust_w = np.ones(len(f))
    iterations = 0
    for iteration in range(15 if robust else 1):
        w = base_w * robust_w
        xd = x - group_means(x, codes, w, len(groups))[codes]
        yd = y - group_means(y, codes, w, len(groups))[codes]
        normal = xd.T @ (w[:, None] * xd)
        bread = np.linalg.pinv(normal, rcond=1e-11)
        beta = bread @ (xd.T @ (w[:, None] * yd))
        residual = yd - xd @ beta
        iterations = iteration + 1
        if not robust:
            break
        scale = np.maximum(np.median(np.abs(residual), axis=0) / .67448975, .5)
        radial = np.sqrt(np.sum((residual / scale) ** 2, axis=1))
        next_w = np.minimum(1., 2. / np.maximum(radial, 1e-9))
        if np.max(np.abs(next_w - robust_w)) < 1e-4:
            break
        robust_w = next_w
    transform = np.zeros((len(parks), x.shape[1]))
    transform[:len(parks)-1, :len(parks)-1] = np.eye(len(parks)-1)
    transform -= transform[parks.index(ANCHOR)].copy()
    value = transform @ beta
    counts = f.groupby("park").agg(games=("game_id", "nunique"), pitchers=("pitcher_id", "nunique"),
                                    rows=("n", "size"), pitches=("n", "sum")).reindex(parks)
    good = (counts.games >= 5) & (counts.pitchers >= 20)
    if not good.loc[ANCHOR]:
        return None
    coef = pd.DataFrame(value, index=parks, columns=AXES).loc[good]
    cov = None
    min_raw_eigen = 0.
    if covariance:
        # Joint X/Z and park covariance, including the uncertainty of the anchor.
        influence = (xd @ bread @ transform.T)[:, :, None] * (w[:, None, None] * residual[:, None, :])
        influence = influence.reshape(len(f), -1)
        cov = np.zeros((len(parks)*2, len(parks)*2))
        nparam = len(groups) + np.linalg.matrix_rank(normal)
        for clusters, sign in [(f.pitcher_id, 1), (f.game_id, 1), (f.pitcher_id+"|"+f.game_id, -1)]:
            cl, names = pd.factorize(clusters, sort=True)
            sums = np.zeros((len(names), cov.shape[0]))
            np.add.at(sums, cl, influence)
            factor = len(names) / (len(names)-1) * (len(f)-1) / max(1, len(f)-nparam)
            cov += sign * factor * (sums.T @ sums)
        indices = [2*i+j for i, p in enumerate(parks) if good.loc[p] for j in range(2)]
        cov = cov[np.ix_(indices, indices)]
        min_raw_eigen = float(np.linalg.eigvalsh(cov).min())
        # Two-way finite-sample sandwich estimates can be indefinite.
        cov = psd(cov)
    return dict(coef=coef, cov=cov, counts=counts.loc[good], cutoff=str(cutoff) if cutoff is not None else None,
                first_date=str(f.game_date.min().date()), last_date=str(f.game_date.max().date()),
                iterations=iterations, min_raw_eigen=min_raw_eigen,
                rank=int(np.linalg.matrix_rank(normal)), columns=x.shape[1])


def monthly_candidate(config, history, month, baseline, universe):
    family = config["family"]
    if family == "pooled":
        return baseline.copy()
    if family == "latest":
        return history[month-1]["coef"].copy()
    out = baseline.copy()
    if family in ["ewma", "precision", "ema", "trend"]:
        for park in out.index:
            observations = [(m, v) for m, v in sorted(history.items()) if park in v["coef"].index]
            if not observations:
                continue
            values = np.stack([v["coef"].loc[park].to_numpy() for _, v in observations])
            ages = np.array([month-m-1 for m, _ in observations])
            if family in ["ewma", "precision"]:
                weights = 2. ** (-ages / config["half"])
                if family == "ewma":
                    weights[ages >= config["window"]] = 0
                    if weights.sum() == 0:
                        continue
                    out.loc[park] = np.average(values, axis=0, weights=weights)
                else:
                    variances = []
                    for m, value in observations:
                        i = value["coef"].index.get_loc(park)
                        variances.append(np.diag(value["cov"])[2*i:2*i+2])
                    reliability = weights[:, None] / (np.maximum(variances, .04) + config["drift"]**2*(ages[:, None]+1))
                    out.loc[park] = (values*reliability).sum(axis=0)/reliability.sum(axis=0)
            elif family == "ema":
                state = values[0].copy()
                for value in values[1:]:
                    state += config["alpha"] * (value-state)
                out.loc[park] = state
            elif family == "trend":
                state = values[-1].copy()
                if len(values) >= 2:
                    slope = (values[-1]-values[-2])/(observations[-1][0]-observations[-2][0])
                    state += config["damp"] * np.clip(slope, -4, 4) * (ages[-1]+1)
                out.loc[park] = state
        return out
    if family == "kalman":
        state_parks = [p for p in universe if p != ANCHOR]
        dimension = len(state_parks)*2
        state = np.zeros(dimension)
        uncertainty = np.eye(dimension)*10000.
        drift_cov = config["drift"]**2 * np.kron(np.eye(len(state_parks))+np.ones((len(state_parks), len(state_parks))), np.eye(2))
        previous = min(history)-1
        observed = set()
        for m, value in sorted(history.items()):
            measured = [p for p in value["coef"].index if p in state_parks]
            if not measured:
                continue
            indices = [2*state_parks.index(p)+j for p in measured for j in range(2)]
            source_indices = [2*value["coef"].index.get_loc(p)+j for p in measured for j in range(2)]
            h = np.eye(dimension)[indices]
            z = value["coef"].loc[measured].to_numpy().ravel()
            r = value["cov"][np.ix_(source_indices, source_indices)]
            p_pred = uncertainty + (m-previous)*drift_cov
            innovation = z-h@state
            s = h@p_pred@h.T+r
            if config["adaptive"] and observed and float(innovation @ np.linalg.solve(s, innovation))/len(z) > 4:
                p_pred += 3*(m-previous)*drift_cov
                s = h@p_pred@h.T+r
            gain = np.linalg.solve(s, h@p_pred).T
            state += gain @ innovation
            a = np.eye(dimension)-gain@h
            uncertainty = a@p_pred@a.T+gain@r@gain.T
            assert np.linalg.eigvalsh(uncertainty).min() >= -1e-8
            observed.update(measured)
            previous = m
        for i, park in enumerate(state_parks):
            if park in observed and park in out.index:
                out.loc[park] = state[2*i:2*i+2]
        out.loc[ANCHOR] = 0.
        return out
    raise ValueError(family)


def centered_complete(coef, fallback, universe):
    """A fixed equal-park zero point also makes weekly estimates comparable."""
    out = fallback.reindex(universe).copy()
    if out.isna().any().any():
        raise ValueError("The evaluation universe requires supported prior estimates")
    present = out.index.intersection(coef.index) if coef is not None else []
    if len(present):
        out.loc[present] = coef.loc[present]
    out -= out.mean(axis=0)
    assert np.isfinite(out.to_numpy()).all()
    return out, set(out.index)-set(present)


def score_residual(test, y, offsets, grouping):
    codes, groups = pd.factorize(grouping, sort=True)
    weights = np.minimum(test.n.to_numpy(), 30)
    residual = y-offsets
    residual -= group_means(residual, codes, weights, len(groups))[codes]
    return residual


def protocol(configs):
    return dict(version=1, grid=configs, primary="sqrt((SSE_X+SSE_Z)/(2*N)); equal cell and axis weights",
                selection_seasons=[2020, 2021, 2022, 2023, 2024], confirmation_season=2025,
                caveat="2025 aggregate baseline results were previously inspected; retrospective confirmation, not untouched prospective validation",
                nested_outer_seasons=[2023, 2024, 2025], plane_ft=17/24, diagnostic_seconds=.4,
                min_pitches_per_cell=5, fit_cell_weight="min(pitch_count,30)",
                min_park_games=5, min_park_pitchers=20, covariance_eigenvalue_floor_cm2=.04,
                weekly_cutoff="Monday 00:00; latest eligible game is strictly earlier; current season only",
                daily_cutoff="00:00 each calendar day; latest eligible game is strictly earlier",
                fortnightly_cutoff="14-day intervals anchored on Monday 1970-01-05; past data only",
                monthly_cutoff="First day 00:00; latest eligible game is strictly earlier; current season only",
                centering="equal-weight supported prior park universe; anchor contrasts estimated relative to Jamsil",
                evaluation="same rows as prior monthly comparison; test pitcher/type mean removed only to score consistency",
                robust="joint standardized residual Huber IRLS; radial cutoff 2; at most 15 iterations",
                fallback="insufficient direct-window support uses most recent supported monthly contrast; then supported season-to-date",
                uncertainty="paired resampling of seasons and circular 2-month blocks within season; 10000 draws; seeded",
                no_offseason_transfer=True)


def run():
    DEST.mkdir(exist_ok=True)
    configs = configurations()
    dump_json(protocol(configs), "protocol.json")
    snapshot = json.loads((OUT / "snapshot.json").read_text())
    raw = Path(snapshot["raw_cache"])
    with gzip.open(raw, "rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == snapshot["pitch_csv_sha256"]
    assert hashlib.sha256((OUT / "manifest.csv").read_bytes()).hexdigest() == snapshot["manifest_csv_sha256"]
    source_key = hashlib.sha256((snapshot["pitch_csv_sha256"]+snapshot["manifest_csv_sha256"]+
                               (OUT/"rolling_calibration.py").read_text(encoding="utf-8")).encode()).hexdigest()
    cached = DEST / "middle-plane-cells.pkl"
    if cached.exists() and (DEST/"cells-source.txt").read_text() == source_key:
        cells = pd.read_pickle(cached)
    else:
        cells = prepare()
        cells.to_pickle(cached)
        (DEST/"cells-source.txt").write_text(source_key)
    print(f"Prepared {len(cells):,} cells; {len(configs)} configurations + uncorrected", flush=True)
    scores, park_scores, type_scores, coverage, audits, observations, checkpoints = [], [], [], [], [], [], []
    all_residuals = []
    old_coverage = pd.read_csv(OUT / "rolling_validation_coverage.csv")
    old_keys = set(zip(old_coverage.season, old_coverage.month))
    start = time.monotonic()
    for season, season_frame in cells.groupby("season"):
        history, direct_cache = {}, {}
        for month, frame in season_frame.groupby("month"):
            cutoff = pd.Timestamp(year=int(season), month=int(month), day=1)
            if (season, month) in old_keys:
                prior = season_frame.loc[season_frame.game_date < cutoff]
                common_model = fit(prior)
                prior_coef = effects(common_model)
                universe = sorted(prior_coef.index)
                latest = history[month-1]["coef"]
                eligible_parks = set(latest.index).intersection(prior_coef.index)
                # Mirrors the previous complete-case comparison support.
                recent_parks = set().union(*(set(v["coef"].index) for m,v in history.items() if 1 <= month-m <= 3))
                eligible_parks &= recent_parks
                test = frame.loc[frame.park.isin(eligible_parks) & frame.pitch_type.isin(common_model["types"])].copy()
                test["fe"] = test.pitcher_id+"|"+test.pitch_type
                support = test.groupby("fe").park.nunique()
                test = test.loc[test.fe.isin(support[support >= 2].index)].copy()
                expected_n = int(old_coverage.loc[(old_coverage.season==season)&(old_coverage.month==month), "rows"].iloc[0])
                assert len(test) == expected_n, (season, month, len(test), expected_n)
                x = design(test, common_model["parks"], common_model["types"])
                x[:, :len(common_model["parks"])-1] = 0
                y = test[AXES].to_numpy() - (x@common_model["beta"])[:, :2]
                fallback = prior_coef.copy()
                for m, value in sorted(history.items()):
                    present = fallback.index.intersection(value["coef"].index)
                    fallback.loc[present] = value["coef"].loc[present]
                offsets_by_model = {"uncorrected": np.zeros((len(test), 2))}
                fallback_counts = {"uncorrected": 0}
                for config in configs:
                    label = config["id"]
                    if config["family"] != "direct":
                        coef = monthly_candidate(config, history, int(month), prior_coef, universe)
                        centered, missing = centered_complete(coef, fallback, universe)
                        offsets_by_model[label] = centered.loc[test.park].to_numpy()
                        fallback_counts[label] = int(test.park.isin(missing).sum())
                        checkpoints.append(dict(season=int(season), month=int(month), model=label,
                            cutoff=str(cutoff.date()), coef=centered.to_dict(orient="index")))
                    else:
                        if config["frequency"] == "weekly":
                            starts = test.game_date-pd.to_timedelta(test.game_date.dt.weekday, unit="D")
                        elif config["frequency"] == "daily":
                            starts = test.game_date
                        elif config["frequency"] == "fortnightly":
                            epoch = pd.Timestamp(1970,1,5)
                            starts = test.game_date-pd.to_timedelta((test.game_date-epoch).dt.days%14, unit="D")
                        else:
                            starts = pd.Series(cutoff, index=test.index)
                        offset = np.empty((len(test), 2))
                        fallbacks = 0
                        for date in sorted(starts.unique()):
                            date = pd.Timestamp(date)
                            key = (date, config["window"], config["half"], config["robust"])
                            if key not in direct_cache:
                                train = season_frame.loc[(season_frame.game_date < date)&(season_frame.game_date >= date-pd.Timedelta(days=config["window"]))]
                                result = estimate(train, date, config["half"], config["robust"], covariance=False)
                                direct_cache[key] = result
                                if len(train):
                                    assert train.game_date.max() < date
                                audits.append(dict(season=int(season), cutoff=str(date.date()), window=config["window"],
                                    half=config["half"], robust=config["robust"], train_rows=len(train),
                                    latest_training_date=str(train.game_date.max().date()) if len(train) else None,
                                    supported_parks=len(result["coef"]) if result else 0,
                                    iterations=result["iterations"] if result else 0))
                            result = direct_cache[key]
                            # At a week's first cutoff, do not use a later monthly fallback.
                            # Usually Monday precedes month start by <=6 days. Reconstruct fallback from completed months at cutoff.
                            causal_fallback = fallback
                            if date < cutoff:
                                early_prior = season_frame.loc[season_frame.game_date < date]
                                early = estimate(early_prior, covariance=False)
                                causal_fallback = prior_coef.copy()*0
                                if early is not None:
                                    causal_fallback.loc[early["coef"].index.intersection(causal_fallback.index)] = early["coef"].reindex(causal_fallback.index).dropna()
                                for m, past in sorted(history.items()):
                                    if pd.Timestamp(year=int(season), month=int(m), day=1)+pd.offsets.MonthBegin(1) <= date:
                                        common = causal_fallback.index.intersection(past["coef"].index)
                                        causal_fallback.loc[common] = past["coef"].loc[common]
                            centered, missing = centered_complete(result["coef"] if result else None, causal_fallback, universe)
                            mask = (starts == date).to_numpy()
                            offset[mask] = centered.loc[test.loc[mask, "park"]].to_numpy()
                            fallbacks += int(test.loc[mask, "park"].isin(missing).sum())
                            checkpoints.append(dict(season=int(season), month=int(month), model=label,
                                cutoff=str(date.date()), coef=centered.to_dict(orient="index")))
                        offsets_by_model[label] = offset
                        fallback_counts[label] = fallbacks
                    assert np.isfinite(offsets_by_model[label]).all()
                for label, offsets in offsets_by_model.items():
                    residual = score_residual(test, y, offsets, test.fe)
                    short_group = test.fe+"|"+((test.game_date.dt.day-1)//14).astype(str)
                    short_support = test.assign(short_group=short_group).groupby("short_group").park.nunique()
                    short_mask = short_group.isin(short_support[short_support >= 2].index).to_numpy()
                    short_residual = score_residual(test.loc[short_mask], y[short_mask], offsets[short_mask], short_group.loc[short_mask])
                    for j, axis in enumerate(AXES):
                        scores.append(dict(season=int(season), month=int(month), model=label, metric=axis,
                            n=len(test), sse=float(np.sum(residual[:,j]**2)), short_n=int(short_mask.sum()),
                            short_sse=float(np.sum(short_residual[:,j]**2)), fallback_n=fallback_counts[label]))
                    squared = pd.DataFrame(residual**2, columns=AXES, index=test.index)
                    for col, dest in [("park", park_scores), ("pitch_type", type_scores)]:
                        squared[col] = test[col]
                        for key_name, sub in squared.groupby(col):
                            dest.append(dict(season=int(season), month=int(month), model=label, **{col:key_name},
                                n=len(sub), x_sse=float(sub.x_cm.sum()), z_sse=float(sub.z_cm.sum())))
                    # Keep per-game clustered loss for independent validation and uncertainty sensitivity.
                    squared["game_id"] = test.game_id
                    per_game = squared.groupby("game_id")[AXES].agg(["sum", "size"])
                    per_game.columns = ["x_sse", "n", "z_sse", "n2"]
                    all_residuals.append(per_game.drop(columns="n2").reset_index().assign(season=season,month=month,model=label))
                coverage.append(dict(season=int(season), month=int(month), rows=len(test), games=test.game_id.nunique(),
                    pitchers=test.pitcher_id.nunique(), parks=test.park.nunique(), earliest_test=str(test.game_date.min().date()),
                    latest_common_nuisance_train=str(prior.game_date.max().date())))
                print(f"Evaluated {season}-{month:02d}: {len(test):,} cells / {len(configs)+1} methods ({time.monotonic()-start:.1f}s)", flush=True)
            monthly = estimate(frame)
            if monthly is not None and len(monthly["coef"]) >= 5:
                history[int(month)] = monthly
                for park, row in monthly["coef"].iterrows():
                    i = monthly["coef"].index.get_loc(park)
                    observations.append(dict(season=season, month=month, park=park, **row.to_dict(),
                        x_se=float(np.sqrt(monthly["cov"][2*i,2*i])), z_se=float(np.sqrt(monthly["cov"][2*i+1,2*i+1])),
                        min_raw_cov_eigenvalue=monthly["min_raw_eigen"], **monthly["counts"].loc[park].to_dict()))
        print(f"Finished season {season}", flush=True)
    save(pd.DataFrame(scores), "scores.csv")
    save(pd.DataFrame(park_scores), "park-scores.csv")
    save(pd.DataFrame(type_scores), "pitch-type-scores.csv")
    save(pd.DataFrame(coverage), "coverage.csv")
    save(pd.DataFrame(audits), "training-audit.csv")
    save(pd.DataFrame(observations), "monthly-observations.csv")
    save(pd.concat(all_residuals, ignore_index=True), "game-losses.csv.gz")
    dump_json(checkpoints, "coefficient-checkpoints.json")
    dump_json(dict(source_snapshot=snapshot, cells=len(cells), configurations=len(configs),
                   source_key=source_key, elapsed_seconds=time.monotonic()-start,
                   script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()), "run.json")
    print("Saved all experiment results", flush=True)


if __name__ == "__main__":
    run()
