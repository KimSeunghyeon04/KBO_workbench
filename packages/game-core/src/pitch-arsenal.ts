import type { PitchArsenalGroup, PitchOutcomeRow } from "@kbo/contracts";

export function summarizePitchArsenal(rows: readonly PitchOutcomeRow[]): PitchArsenalGroup[] {
  const groups = new Map<
    string,
    {
      balls: number;
      strikes: number;
      stance: string | null;
      pitches: number;
      types: Map<string | null, number>;
    }
  >();
  for (const row of rows) {
    const key = JSON.stringify([row.stance, row.balls, row.strikes]);
    const group = groups.get(key) ?? {
      balls: row.balls,
      strikes: row.strikes,
      stance: row.stance,
      pitches: 0,
      types: new Map<string | null, number>(),
    };
    group.pitches++;
    group.types.set(row.pitchType, (group.types.get(row.pitchType) ?? 0) + 1);
    groups.set(key, group);
  }
  const compare = (a: string | null, b: string | null) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  };
  return [...groups.values()]
    .sort((a, b) => compare(a.stance, b.stance) || a.strikes - b.strikes || a.balls - b.balls)
    .map((group) => ({
      balls: group.balls,
      strikes: group.strikes,
      stance: group.stance,
      pitches: group.pitches,
      types: [...group.types]
        .sort(([a], [b]) => compare(a, b))
        .map(([pitchType, pitches]) => ({
          pitchType,
          pitches,
          usageRate: pitches / group.pitches,
        })),
    }));
}
