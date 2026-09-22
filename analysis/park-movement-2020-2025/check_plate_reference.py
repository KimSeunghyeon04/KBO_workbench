"""Read-only follow-up: identify when the provider plate reference changes."""

from pathlib import Path
import collections
import gzip
import hashlib
import json
import sys

import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding="utf-8")
out = Path(__file__).resolve().parent
root = out.parents[1]
snapshot = json.loads((out / "snapshot.json").read_text())
d = pd.read_csv(snapshot["raw_cache"])
manifest = pd.read_csv(out / "manifest.csv")
d = d.merge(manifest[["game_id", "revision", "season", "game_date", "stadium"]],
            on=["game_id", "revision"], validate="many_to_one")
d = d.loc[(d.season >= 2024) & d.cross_plate_y.notna()].copy()
summary = d.groupby(["season", "cross_plate_y"]).agg(pitches=("game_id", "size"),
    games=("game_id", "nunique"), first=("game_date", "min"), last=("game_date", "max"))
summary.reset_index().to_csv(out / "plate_reference_periods.csv", index=False)
print(summary.to_string())
park = d.groupby(["season", "stadium", "cross_plate_y"]).agg(pitches=("game_id", "size"),
    games=("game_id", "nunique"), first=("game_date", "min"), last=("game_date", "max"))
park.reset_index().to_csv(out / "plate_reference_by_park.csv", index=False, encoding="utf-8-sig")
print(d.loc[d.game_id == "20240314HTOB02024"].groupby("cross_plate_y")
      .pitch_sequence.agg(["min", "max", "count"]).to_string())
with np.errstate(all="ignore"):
    def crossing(y):
        dist = d.y0 - y
        return 2*dist/(-d.vy0 + np.sqrt(d.vy0**2 - 2*d.ay*dist))
    front, middle = crossing(1.4167), crossing(.7083)
    print("front_to_middle_median_ms", ((middle-front)*1000).median())
    print("front_to_middle_median_height_cm",
          ((d.vz0*(middle-front)+d.az*(middle**2-front**2)/2)*30.48).median())

def walk(value):
    if isinstance(value, dict):
        if "crossPlateY" in value:
            yield value["crossPlateY"]
        for v in value.values():
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)

sources = [
    (2024, "20240314HTOB02024", "50fb6761a2787f45305d5de74b145b28df6a1bb55d6448c6b8cef97fed763768"),
    (2025, "20250308LGKT02025", "bf0be343f05f9ee1853943afacd382ef782da66146b1905d24e3175922fcb564"),
]
evidence = []
for season, game, source_hash in sources:
    directory = root / ".data" / "source" / str(season) / game / source_hash
    source_manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    for endpoint in source_manifest["endpoints"]:
        if endpoint["name"] not in ["relay_001", "relay_002", "relay_003"]:
            continue
        raw = gzip.decompress((directory / (endpoint["name"]+".json.gz")).read_bytes())
        assert hashlib.sha256(raw).hexdigest() == endpoint["hash"]
        counts = dict(collections.Counter(walk(json.loads(raw))))
        evidence.append(dict(game_id=game, endpoint=endpoint["name"],
            source_hash=source_hash, endpoint_sha256=endpoint["hash"], values=counts))
        print(game, endpoint["name"], counts)
(out / "plate_reference_source_check.json").write_text(
    json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
