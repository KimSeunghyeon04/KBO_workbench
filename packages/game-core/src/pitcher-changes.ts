import type {
  PitchChangeObservation,
  PitcherChangesQuery,
  PitcherChangesResponse,
  AnalysisScope,
  PitchProfileGroup,
} from "@kbo/contracts";
import { summarizePitchProfile } from "./pitch-profile.js";
const mean = (v: readonly number[]) =>
  v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
const gameKey = (r: { gameId: string; revision: number }) => JSON.stringify([r.gameId, r.revision]);
type Metric = PitcherChangesResponse["changes"][number]["metrics"][number];
type Game = PitcherChangesResponse["games"][number];
const metrics = ["speedKph", "xCm", "zCm", "arrivalMs", "usage"] as const;
function profile(rows: PitchChangeObservation[]): PitchProfileGroup[] {
  return summarizePitchProfile(
    rows,
    rows.flatMap((r) =>
      !r.calibrated || r.xCm === null || r.zCm === null || r.arrivalMs === null
        ? []
        : [
            {
              ...r,
              xCm: r.xCm,
              zCm: r.zCm,
              arrivalMs: r.arrivalMs,
              calibrationStatus: r.calibrated
                ? ("applied" as const)
                : ("insufficient_data" as const),
            },
          ],
    ),
  ).groups;
}
function window(
  games: Game[],
  byGame: Map<string, PitchChangeObservation[]>,
): PitcherChangesResponse["recent"] {
  const rows = games.flatMap((g) => byGame.get(gameKey(g)) ?? []);
  const counts = (fn: (r: PitchChangeObservation) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = fn(r);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, pitches]) => ({ key, pitches }));
  };
  return {
    games,
    pitches: rows.length,
    calibrated: rows.filter((r) => r.calibrated).length,
    parks: counts((r) => r.stadium ?? "미상"),
    counts: counts((r) => `${r.balls}-${r.strikes}`),
    stances: counts((r) => r.stance ?? "미상"),
  };
}
/** Windows are selected before pitch-type filtering. Same-date games never acquire a fabricated order. */
export function analyzePitcherChanges(
  query: PitcherChangesQuery,
  pitcherId: string,
  scope: AnalysisScope,
  sourceHash: string,
  input: readonly PitchChangeObservation[],
  baselineLastDate: string | null,
  seed = 73129,
): PitcherChangesResponse {
  const byGame = new Map<string, PitchChangeObservation[]>();
  for (const r of input) {
    if (r.gameDate > query.dateTo || (query.dateFrom !== undefined && r.gameDate < query.dateFrom))
      continue;
    const key = gameKey(r),
      group = byGame.get(key) ?? [];
    group.push(r);
    byGame.set(key, group);
  }
  const games: Game[] = [...byGame.values()]
    .map((rows) => {
      const first = rows[0];
      if (first === undefined) throw new Error("Empty appearance");
      rows.sort((a, b) => (a.pitchId < b.pitchId ? -1 : a.pitchId > b.pitchId ? 1 : 0));
      return {
        gameId: first.gameId,
        revision: first.revision,
        gameDate: first.gameDate,
        stadium: first.stadium,
        pitches: rows.length,
        groups: profile(rows),
      };
    })
    .sort((a, b) =>
      a.gameDate === b.gameDate
        ? a.gameId < b.gameId
          ? -1
          : a.gameId > b.gameId
            ? 1
            : 0
        : a.gameDate < b.gameDate
          ? -1
          : 1,
    );
  const last = games.slice(-8);
  const ambiguous = last.some(
    (g) => games.filter((other) => other.gameDate === g.gameDate).length > 1,
  );
  const status = ambiguous
    ? "ambiguous_same_day"
    : last.length < 8
      ? "insufficient_games"
      : "ready";
  const recent = window(ambiguous ? [] : games.slice(-3), byGame),
    previous = window(ambiguous ? [] : games.slice(-8, -3), byGame);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bootstrapReplicates = 1200;
  const types = [...new Set(last.flatMap((g) => g.groups.map((t) => t.pitchType)))].sort((a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1,
  );
  const changes = ambiguous
    ? []
    : types.map((pitchType) => ({
        pitchType,
        metrics: metrics.map((metric): Metric => {
          const prepare = (gs: Game[]) =>
            gs.map((g) => {
              const all = byGame.get(gameKey(g)) ?? [],
                selected = all.filter((r) => r.pitchType === pitchType);
              const values =
                metric === "usage"
                  ? []
                  : selected.flatMap((r) => {
                      const value = r[metric];
                      return value === null ||
                        !Number.isFinite(value) ||
                        (metric !== "speedKph" && !r.calibrated)
                        ? []
                        : [value];
                    });
              return {
                sum: metric === "usage" ? selected.length : values.reduce((a, b) => a + b, 0),
                n: metric === "usage" ? all.length : values.length,
                typeCount: selected.length,
              };
            });
          const a = prepare(recent.games),
            b = prepare(previous.games);
          const aggregate = (xs: typeof a) => {
            const n = xs.reduce((s, g) => s + g.n, 0);
            return n === 0 ? null : xs.reduce((s, g) => s + g.sum, 0) / n;
          };
          const am = aggregate(a),
            bm = aggregate(b),
            an = a.reduce((s, g) => s + (metric === "usage" ? g.typeCount : g.n), 0),
            bn = b.reduce((s, g) => s + (metric === "usage" ? g.typeCount : g.n), 0);
          const ag = a.filter((g) => (metric === "usage" ? g.typeCount : g.n) > 0).length,
            bg = b.filter((g) => (metric === "usage" ? g.typeCount : g.n) > 0).length;
          const enough = an >= 30 && bn >= 30 && ag >= 3 && bg >= 3;
          const draws: number[] = [];
          if (enough) {
            for (let i = 0; i < bootstrapReplicates; i++) {
              const sample = (xs: typeof a) =>
                xs.map(() => xs[Math.floor(random() * xs.length)]).filter((g) => g !== undefined);
              const x = aggregate(sample(a)),
                y = aggregate(sample(b));
              if (x !== null && y !== null) draws.push(x - y);
            }
            draws.sort((x, y) => x - y);
          }
          return {
            metric,
            recent: am,
            previous: bm,
            difference: am === null || bm === null ? null : am - bm,
            recentGameMean: mean(a.flatMap((g) => (g.n === 0 ? [] : [g.sum / g.n]))),
            previousGameMean: mean(b.flatMap((g) => (g.n === 0 ? [] : [g.sum / g.n]))),
            recentCount: an,
            previousCount: bn,
            recentGames: ag,
            previousGames: bg,
            status:
              am === null || bm === null ? "unavailable" : enough ? "sufficient" : "small_sample",
            lower: draws[Math.floor(draws.length * 0.025)] ?? null,
            upper: draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.975))] ?? null,
          };
        }),
      }));
  return {
    query,
    pitcherId,
    scope,
    sourceHash,
    status,
    seed,
    bootstrapReplicates,
    baselineLastDate,
    games,
    recent,
    previous,
    changes,
  };
}
