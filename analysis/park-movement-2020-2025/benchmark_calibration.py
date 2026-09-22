"""Local offline timings; does not measure PostgreSQL or the production API."""

import gc
import json
import platform
import sys
import time

from calibration_search import DEST, OUT, estimate
from rolling_calibration import prepare
import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")


def summary(values):
    return dict(n=len(values), median_ms=float(np.median(values)*1000),
                p95_ms=float(np.quantile(values,.95)*1000), min_ms=float(min(values)*1000), max_ms=float(max(values)*1000))


def main():
    cached=[]
    for _ in range(5):
        start=time.perf_counter()
        cells=pd.read_pickle(DEST/"middle-plane-cells.pkl")
        cached.append(time.perf_counter()-start)
    data_memory=int(cells.memory_usage(index=True,deep=True).sum())
    checkpoints=json.loads((DEST/"coefficient-checkpoints.json").read_text(encoding="utf-8"))
    selected=[c for c in checkpoints if c["model"]=="daily_w84_h7"]
    dates2025=sorted({pd.Timestamp(c["cutoff"]) for c in selected if c["season"]==2025})
    dates=[dates2025[i] for i in np.linspace(0,len(dates2025)-1,15).astype(int)]
    sf=cells.loc[cells.season==2025]
    records=[]
    # Warm the same numerical and grouping paths used in the measured fits.
    warm=sf.loc[(sf.game_date<dates[0])&(sf.game_date>=dates[0]-pd.Timedelta(days=84))]
    estimate(warm,dates[0],half=7,covariance=True)
    for repeat in range(5):
        for date in dates:
            for covariance in [False,True]:
                start=time.perf_counter()
                frame=sf.loc[(sf.game_date<date)&(sf.game_date>=date-pd.Timedelta(days=84))]
                model=estimate(frame,date,half=7,covariance=covariance)
                elapsed=time.perf_counter()-start
                assert model is not None and model["coef"].shape[1]==2
                records.append(dict(date=str(date.date()), repeat=repeat, covariance=covariance,
                    elapsed_ms=elapsed*1000, input_cells=len(frame), input_games=frame.game_id.nunique(),
                    aggregate_pitch_count=int(frame.n.sum()), output_parks=len(model["coef"]),
                    columns=model["columns"], rank=model["rank"], input_memory_bytes=int(frame.memory_usage(index=True,deep=True).sum())))
    pd.DataFrame(records).to_csv(DEST/"performance-fits.csv",index=False,encoding="utf-8-sig")
    times={}
    for covariance in [False,True]:
        subset=[r["elapsed_ms"]/1000 for r in records if r["covariance"]==covariance]
        times["with_covariance" if covariance else "coefficients_only"]=summary(subset)
    print("Daily all-park fit: "+json.dumps(times),flush=True)
    # Sequential historical coefficient generation, reusing the in-memory cells.
    # No multiprocessing or cross-date sufficient-statistics optimization.
    season_frames={int(year):frame for year,frame in cells.groupby("season")}
    start=time.perf_counter()
    count=0
    for cutoff in sorted({(c["season"],c["cutoff"]) for c in selected}):
        season,date_string=cutoff
        date=pd.Timestamp(date_string)
        frame=season_frames[season]
        frame=frame.loc[(frame.game_date<date)&(frame.game_date>=date-pd.Timedelta(days=84))]
        model=estimate(frame,date,half=7,covariance=True)
        assert model is not None
        count+=1
    backfill_seconds=time.perf_counter()-start
    print(f"Historical {count} dates with covariance: {backfill_seconds:.3f}s",flush=True)
    # Full existing file scan: gzip CSV, join manifest, trajectory validity,
    # aggregation. Repeated reads may benefit from the OS file cache.
    preparations=[]
    for repeat in range(3):
        gc.collect()
        start=time.perf_counter()
        rebuilt=prepare()
        preparations.append(time.perf_counter()-start)
        assert len(rebuilt)==len(cells)
        pd.testing.assert_frame_equal(rebuilt.reset_index(drop=True),cells.reset_index(drop=True))
        del rebuilt
        print(f"Full 1.43m-pitch preparation #{repeat+1}: {preparations[-1]:.3f}s",flush=True)
    # Actual cell values and actual daily profiles seed a separate JS microbenchmark.
    cutoff=pd.Timestamp("2025-09-01")
    frame=sf.loc[(sf.game_date<cutoff)&(sf.game_date>=cutoff-pd.Timedelta(days=84))]
    model=estimate(frame,cutoff,half=7,covariance=False)
    application_rows=sf.loc[(sf.game_date>=cutoff)&sf.park.isin(model["coef"].index),["game_id","park","x_cm","z_cm"]]
    profile_by_game={r.game_id:model["coef"].loc[r.park].tolist() for r in application_rows.itertuples()}
    payload=dict(note="Operation-only benchmark: repeated actual cell means; one frozen example profile; no database, trajectory or GMM timing",
        rows=[dict(gameId=r.game_id,x=r.x_cm,z=r.z_cm) for r in application_rows.itertuples()],profiles=profile_by_game)
    (DEST/"performance-application-input.json").write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")
    result=dict(measured_at_local="2026-09-20",python=platform.python_version(),numpy=np.__version__,pandas=pd.__version__,
        cpu="AMD Ryzen 5 9600X (6 cores / 12 logical processors)",blas_threads="1 requested before importing numpy",
        scope="Local Python research implementation, elapsed time; excludes DB extraction, process startup and production API",
        cached_82575_cells=summary(cached),all_cells_memory_bytes=data_memory,
        daily_fit=times,daily_fit_dates=15,repeats_per_date=5,
        window_cell_range=[min(r["input_cells"] for r in records),max(r["input_cells"] for r in records)],
        window_game_range=[min(r["input_games"] for r in records),max(r["input_games"] for r in records)],
        window_input_memory_bytes_range=[min(r["input_memory_bytes"] for r in records),max(r["input_memory_bytes"] for r in records)],
        regression_columns=sorted({r["columns"] for r in records}),
        historical_backfill=dict(dates=count,seconds=backfill_seconds,includes_covariance=True,
            scope="Only the 24 evaluated season-months; not all dates in six complete seasons"),
        full_raw_file_prepare=summary(preparations),
        full_raw_prepare_note="Existing gzip read plus manifest join, validity and aggregation; OS cache may be warm; excludes DB read",
        production_integration_benchmarked=False)
    (DEST/"performance.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False,indent=2),flush=True)


if __name__=="__main__":
    main()
