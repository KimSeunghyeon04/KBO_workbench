"""Read-only, repeatable-read extract; never changes application data."""

from pathlib import Path
import gzip
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone

OUT = Path(__file__).resolve().parent
CACHE = Path(os.environ["TEMP"]) / "kbo-park-movement-20260920"
CACHE.mkdir(exist_ok=True)

sql = r"""
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='180s';
\echo __MANIFEST__
COPY (SELECT game_id,revision,season,game_date,stadium,document_hash,projection_hash
 FROM analytics.current_game_revisions WHERE season BETWEEN 2020 AND 2025
 ORDER BY game_id COLLATE "C") TO STDOUT CSV HEADER;
\echo __PITCHES__
COPY (SELECT p.game_id,p.revision,p.pitch_sequence,p.pitcher_id,p.half,p.pitch_type,
 p.speed_kph,p.stance,p.tracking_id,t.measurement_profile_id,
 p.x0,p.y0,p.z0,p.vx0,p.vy0,p.vz0,p.ax,p.ay,p.az,p.cross_plate_x,p.cross_plate_y,
 p.before_balls,p.before_strikes
 FROM analytics.current_pitches p
 LEFT JOIN workbench.tracking_observations t
 ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id
 WHERE p.actual AND p.season BETWEEN 2020 AND 2025
 ORDER BY p.game_id COLLATE "C",p.pitch_sequence) TO STDOUT CSV HEADER;
\echo __END__
COMMIT;
"""
(OUT / "extract.sql").write_text(sql, encoding="utf-8")
process = subprocess.Popen(
    ["docker", "exec", "-i", "kbo-workbench-db-1", "psql", "-U", "kbo", "-d", "kbo", "-X", "-q"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
)
process.stdin.write(sql.encode("utf-8"))
process.stdin.close()
target = None
counts = {"manifest": 0, "pitches": 0}
mode = None
digest = hashlib.sha256()
for line in process.stdout:
    marker = line.strip()
    if marker in (b"__MANIFEST__", b"__PITCHES__", b"__END__"):
        if target:
            target.close()
        if marker == b"__END__":
            mode = None
            target = None
        elif marker == b"__MANIFEST__":
            mode = "manifest"
            target = (OUT / "manifest.csv").open("wb")
        else:
            mode = "pitches"
            target = gzip.open(CACHE / "pitches.csv.gz", "wb", compresslevel=1)
        continue
    if target:
        target.write(line)
        counts[mode] += 1
        if mode == "pitches":
            digest.update(line)
            if counts[mode] % 250000 == 0:
                print(f"extracted {counts[mode]:,} pitch rows", flush=True)
error = process.stderr.read().decode("utf-8", errors="replace")
if process.wait() != 0:
    raise RuntimeError(error)
metadata = {
    "extracted_at_utc": datetime.now(timezone.utc).isoformat(),
    "transaction": "REPEATABLE READ READ ONLY",
    "games": counts["manifest"] - 1,
    "actual_pitches": counts["pitches"] - 1,
    "pitch_csv_sha256": digest.hexdigest(),
    "manifest_csv_sha256": hashlib.sha256((OUT / "manifest.csv").read_bytes()).hexdigest(),
    "raw_cache": str(CACHE / "pitches.csv.gz"),
}
(OUT / "snapshot.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
print(json.dumps(metadata, indent=2), flush=True)
