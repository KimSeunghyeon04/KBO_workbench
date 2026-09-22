import type {
  MatchupQuery,
  MatchupResponse,
  MatchupCondition,
  MatchupConditionCounts,
  PitchOutcomeRow,
  TerminalPaRow,
  AnalysisScope,
} from "@kbo/contracts";
const divide = (n: number, d: number) => (d === 0 ? null : n / d);
const key = (r: MatchupCondition) =>
  JSON.stringify([r.pitchType, r.balls, r.strikes, r.stance, r.speedBand]);
export function matchupCondition(
  row: Pick<
    PitchOutcomeRow,
    "pitchType" | "speedKph" | "stance" | "balls" | "strikes" | "eligible"
  >,
): MatchupCondition | null {
  if (
    !row.eligible ||
    row.pitchType === null ||
    row.speedKph === null ||
    !Number.isFinite(row.speedKph) ||
    row.speedKph <= 0 ||
    row.speedKph >= 500 ||
    row.stance === null
  )
    return null;
  return {
    pitchType: row.pitchType,
    balls: row.balls,
    strikes: row.strikes,
    stance: row.stance,
    speedBand: Math.floor(row.speedKph / 5),
  };
}
function cohort(rows: PitchOutcomeRow[]): MatchupResponse["direct"] {
  const swings = rows.filter((r) => r.swing).length,
    whiffs = rows.filter((r) => r.whiff).length,
    calledStrikes = rows.filter((r) => r.calledStrike).length;
  return {
    pitches: rows.length,
    games: new Set(rows.map((r) => JSON.stringify([r.gameId, r.revision]))).size,
    pitchers: new Set(rows.flatMap((r) => (r.pitcherId === null ? [] : [r.pitcherId]))).size,
    swings,
    whiffs,
    calledStrikes,
    swingRate: divide(swings, rows.length),
    whiffRate: divide(whiffs, swings),
    calledStrikeRate: divide(calledStrikes, rows.length),
    rows: rows.map((r) => ({
      gameId: r.gameId,
      revision: r.revision,
      pitchId: r.pitchId,
      gameDate: r.gameDate,
      pitcherId: r.pitcherId,
      pitchType: r.pitchType,
      speedKph: r.speedKph,
      balls: r.balls,
      strikes: r.strikes,
      stance: r.stance,
      swing: r.swing,
      whiff: r.whiff,
      calledStrike: r.calledStrike,
    })),
  };
}
export function analyzeMatchup(
  query: MatchupQuery,
  scope: AnalysisScope,
  sourceHash: string,
  rows: readonly PitchOutcomeRow[],
  pas: readonly TerminalPaRow[],
  pitcherConditions: readonly MatchupConditionCounts[],
  league: readonly MatchupConditionCounts[],
): MatchupResponse {
  const target = new Map(pitcherConditions.map((r) => [key(r), r])),
    controls = new Map(league.map((r) => [key(r), r])),
    byCondition = new Map<string, PitchOutcomeRow[]>();
  const own = rows.filter((r) => r.batterId === query.batterId);
  const similar = own.filter((r) => {
    const condition = matchupCondition(r);
    if (condition === null || !target.has(key(condition))) return false;
    const k = key(condition),
      group = byCondition.get(k) ?? [];
    group.push(r);
    byCondition.set(k, group);
    return true;
  });
  let matchedPitches = 0,
    matchedSwings = 0,
    expectedSwings = 0,
    expectedWhiffs = 0,
    expectedCalled = 0,
    observedSwings = 0,
    observedWhiffs = 0,
    observedCalled = 0;
  const conditions = [...target]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, t]) => {
      const b = byCondition.get(id) ?? [],
        control = controls.get(id),
        sufficient = control !== undefined && control.pitches >= 20;
      if (sufficient) {
        matchedPitches += b.length;
        observedSwings += b.filter((r) => r.swing).length;
        observedCalled += b.filter((r) => r.calledStrike).length;
        expectedSwings += (b.length * control.swings) / control.pitches;
        expectedCalled += (b.length * control.calledStrikes) / control.pitches;
      }
      if (control !== undefined && control.swings >= 20) {
        const swings = b.filter((r) => r.swing).length;
        matchedSwings += swings;
        observedWhiffs += b.filter((r) => r.whiff).length;
        expectedWhiffs += (swings * control.whiffs) / control.swings;
      }
      return {
        pitchType: t.pitchType,
        balls: t.balls,
        strikes: t.strikes,
        stance: t.stance,
        speedBand: t.speedBand,
        targetPitcherPitches: t.pitches,
        batterPitches: b.length,
        leaguePitches: control?.pitches ?? 0,
        leagueSwings: control?.swings ?? 0,
        leagueSwingRate: sufficient ? divide(control.swings, control.pitches) : null,
        leagueWhiffRate:
          control !== undefined && control.swings >= 20
            ? divide(control.whiffs, control.swings)
            : null,
      };
    });
  return {
    query,
    scope,
    sourceHash,
    predictionStatus: "not_validated",
    speedBandKph: 5,
    minControls: 20,
    direct: cohort(own.filter((r) => r.pitcherId === query.pitcherId)),
    directPlateAppearances: pas.filter(
      (p) =>
        p.batterId === query.batterId &&
        p.pitcherId === query.pitcherId &&
        p.completed &&
        p.countsAsPa,
    ),
    similar: cohort(similar),
    excludedSimilar: own.length - similar.length,
    matched: {
      pitches: matchedPitches,
      swings: matchedSwings,
      leagueSwingRate: divide(expectedSwings, matchedPitches),
      leagueWhiffRate: divide(expectedWhiffs, matchedSwings),
      leagueCalledStrikeRate: divide(expectedCalled, matchedPitches),
      observedSwingRate: divide(observedSwings, matchedPitches),
      observedWhiffRate: divide(observedWhiffs, matchedSwings),
      observedCalledStrikeRate: divide(observedCalled, matchedPitches),
    },
    conditions,
  };
}
