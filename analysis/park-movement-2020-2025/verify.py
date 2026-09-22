"""Numerical invariants for the offline analysis."""

import json
import subprocess
import numpy as np
import pandas as pd
from analyze import OUT, METRICS, fit

rng = np.random.default_rng(4321)
rows = []
effect = np.array([[4,-2,1,0.2],[-3,5,2,0.5],[2,-1,-3,-0.7]])
for player in range(30):
    for month in [4,5]:
        intercept = rng.normal(size=4)*10
        for park in range(3):
            for repeat in range(3):
                speed = rng.uniform(125,150)
                left,balls,strikes = rng.uniform(size=3)
                y = intercept+effect[park]+(speed-140)*.3+left*.4+balls*.7+strikes*.2
                rows.append(dict(season=2025,game_id=f"{month}-{park}-{repeat}",pitcher_id=str(player),
                    pitch_type="test",park=str(park),month=month,n=20,speed50=speed,
                    left=left,balls=balls,strikes=strikes,**dict(zip(METRICS,y))))
model = fit(pd.DataFrame(rows))
actual = model["output"][METRICS].to_numpy()
expected = effect-effect.mean(axis=0)
assert np.max(np.abs(actual-expected)) < 1e-9
e = pd.read_csv(OUT / "park_effects.csv")
for season, f in e.groupby("season"):
    assert np.max(np.abs(np.average(f[METRICS],weights=f.pitches,axis=0))) < 1e-8
counts = pd.read_csv(OUT / "model_counts.csv")
assert (counts["rank"] == counts["columns"]).all()
node_code = '''import fs from "node:fs";
import {alignPitchTrajectory} from "@kbo/game-core";
const rows=JSON.parse(fs.readFileSync(INPUT,"utf8"));
let max=0;
for(const row of rows){
 const p=alignPitchTrajectory(row.input);
 if(!p) throw Error("Unexpected rejection");
 const actual=[p.lateralAcceleration,p.verticalAcceleration,p.speedKph,p.arrivalSeconds];
 actual.forEach((v,i)=>{max=Math.max(max,Math.abs(v-row.expected[i]));});
}
if(max>1e-10) throw Error("Trajectory mismatch");
console.log(JSON.stringify({samples:rows.length,maxAbsoluteError:max}));
'''.replace("INPUT", json.dumps(str(OUT / "verification-input.json")))
check = subprocess.run(["node","--input-type=module","-e",node_code],
    cwd=OUT.parents[1]/"apps"/"server",capture_output=True,text=True,check=True)
trajectory = json.loads(check.stdout)
checks = dict(synthetic_max_error=float(np.max(np.abs(actual-expected))),
    annual_design_full_rank=True,annual_pitch_weighted_effects_sum_to_zero=True,
    trajectory_public_api_sample_count=trajectory["samples"],
    trajectory_public_api_max_absolute_error=trajectory["maxAbsoluteError"])
(OUT / "verification.json").write_text(json.dumps(checks,indent=2),encoding="utf-8")
print(json.dumps(checks,indent=2))
