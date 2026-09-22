import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisCompetitionSchema,
  AnalysisCoverageCountsSchema,
  AnalysisCoverageResponseSchema,
  AnalysisScopeSchema,
  canonicalStringify,
  inAnalysisPeriod,
  validAnalysisCoverage,
  type AnalysisCoverageCounts,
  type AnalysisCoverageResponse,
  type AnalysisScope,
  type PitchCalibrationSeason,
} from "@kbo/contracts";
import type { PitchAnalysisRow } from "./pitch-analysis-repository.js";
import {
  middlePlaneTrajectory,
  pitchCalibrationHash,
  pitchCalibrationLookup,
} from "./pitch-calibration.js";

const strict = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const count = Type.Integer({ minimum: 0 });
export const CoverageGameSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    documentHash: Type.String(),
    gameDate: Type.String(),
    stadium: Type.Union([Type.String(), Type.Null()]),
    competition: AnalysisCompetitionSchema,
    actualPitches: count,
    withPitchType: count,
    withSpeed: count,
    zoneKnown: count,
    completedPlateAppearances: count,
  },
  strict,
);
export type CoverageGame = Static<typeof CoverageGameSchema>;
// Bump when coverage eligibility, trajectory/zone definitions, or aggregation semantics change.
export const COVERAGE_SUMMARY_VERSION = 1;
export const CoverageSeasonSchema = Type.Object(
  {
    version: Type.Literal(COVERAGE_SUMMARY_VERSION),
    sourceKey: hash,
    referenceHash: hash,
    calibrationHash: hash,
    scope: AnalysisScopeSchema,
    games: Type.Array(
      Type.Object({ game: CoverageGameSchema, counts: AnalysisCoverageCountsSchema }, strict),
    ),
  },
  strict,
);
export type CoverageSeason = Static<typeof CoverageSeasonSchema>;
export const coverageHash = (value: unknown): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
const emptyCounts = (): AnalysisCoverageCounts => ({
  games: 0,
  actualPitches: 0,
  completedPlateAppearances: 0,
  withPitchType: 0,
  withSpeed: 0,
  zoneKnown: 0,
  linkedTracking: 0,
  missingTracking: 0,
  invalidTrajectory: 0,
  validTrajectory: 0,
  calibratedTrajectory: 0,
  insufficientCalibration: 0,
  unsupportedPark: 0,
});
const countKeys = Object.keys(
  AnalysisCoverageCountsSchema.properties,
) as (keyof AnalysisCoverageCounts)[];

export async function buildCoverageSeason(
  scope: AnalysisScope,
  sourceKey: string,
  referenceHash: string,
  games: CoverageGame[],
  rows: readonly PitchAnalysisRow[],
  calibration: PitchCalibrationSeason,
  signal?: AbortSignal,
): Promise<CoverageSeason> {
  const entries = games.map((game) => ({
    game,
    counts: {
      ...emptyCounts(),
      games: 1,
      actualPitches: game.actualPitches,
      completedPlateAppearances: game.completedPlateAppearances,
      withPitchType: game.withPitchType,
      withSpeed: game.withSpeed,
      zoneKnown: game.zoneKnown,
    },
  }));
  const byGame = new Map(entries.map((entry) => [entry.game.gameId, entry]));
  const lookup = pitchCalibrationLookup(calibration);
  let processed = 0;
  for (const row of rows) {
    const entry = byGame.get(row.gameId);
    if (entry === undefined || entry.game.revision !== row.revision)
      throw new Error("Coverage pitch has no game revision");
    const c = entry.counts;
    if (row.trackingId === null) c.missingTracking++;
    else {
      c.linkedTracking++;
      if (middlePlaneTrajectory(row) === null) c.invalidTrajectory++;
      else {
        c.validTrajectory++;
        const status = lookup(row).status;
        if (status === "applied") c.calibratedTrajectory++;
        else if (status === "unsupported_park") c.unsupportedPark++;
        else c.insufficientCalibration++;
      }
    }
    if (++processed % 2000 === 0) {
      await setImmediate();
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return Value.Decode(CoverageSeasonSchema, {
    version: COVERAGE_SUMMARY_VERSION,
    sourceKey,
    referenceHash,
    calibrationHash: pitchCalibrationHash(calibration),
    scope,
    games: entries,
  });
}

export function coverageResponse(
  summary: CoverageSeason,
  scope: AnalysisScope,
): AnalysisCoverageResponse {
  const selected = summary.games.filter(({ game }) => inAnalysisPeriod(game.gameDate, scope));
  const games = selected.map(({ game }) => game);
  const stadiums = new Map<string | null, AnalysisCoverageCounts>();
  const total = emptyCounts();
  for (const { game, counts } of selected) {
    const c = stadiums.get(game.stadium) ?? emptyCounts();
    for (const key of countKeys) {
      c[key] += counts[key];
      total[key] += counts[key];
    }
    stadiums.set(game.stadium, c);
  }
  const dates = games.map((g) => g.gameDate).sort();
  const response = Value.Decode(AnalysisCoverageResponseSchema, {
    version: 1,
    season: scope.season,
    scope,
    sourceHash: coverageHash({ version: 1, scope, referenceHash: summary.referenceHash, games }),
    calibrationHash: summary.calibrationHash,
    unclassifiedGames: games.filter((g) => g.competition === "unknown").length,
    competitions: (["preseason", "regular", "postseason", "unknown"] as const).map(
      (competition) => ({
        competition,
        games: games.filter((g) => g.competition === competition).length,
      }),
    ),
    firstGameDate: dates[0] ?? null,
    lastGameDate: dates.at(-1) ?? null,
    total,
    stadiums: [...stadiums]
      .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
      .map(([stadium, counts]) => ({ stadium, counts })),
  });
  if (!validAnalysisCoverage(response)) throw new Error("Inconsistent analysis coverage");
  return response;
}

export function validCoverageSeason(value: CoverageSeason): boolean {
  if (value.scope.dateFrom !== null || value.scope.dateTo !== null) return false;
  let previous = "";
  for (const { game, counts } of value.games) {
    if (
      game.gameId <= previous ||
      counts.games !== 1 ||
      !game.gameDate.startsWith(`${value.scope.season}-`) ||
      (value.scope.competition !== "all" && game.competition !== value.scope.competition) ||
      (
        [
          "actualPitches",
          "completedPlateAppearances",
          "withPitchType",
          "withSpeed",
          "zoneKnown",
        ] as const
      ).some((key) => counts[key] !== game[key])
    )
      return false;
    previous = game.gameId;
    try {
      coverageResponse({ ...value, games: [{ game, counts }] }, value.scope);
    } catch {
      return false;
    }
  }
  return true;
}
