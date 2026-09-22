const rowKeys = new Set([
  "text",
  "type",
  "seqno",
  "batterId",
  "pitcherId",
  "runnerId",
  "batter_id",
  "pitcher_id",
  "runner_id",
  "ptsPitchId",
  "sourcePitchId",
  "pitchId",
  "speed",
  "stuff",
  "playerChange",
  "currentGameState",
  "observed_state_after",
]);
const contextKeys = new Set([
  "type",
  "inPlayer",
  "outPlayer",
  "shiftPlayer",
  "shiftMessage",
  "playerId",
  "playerName",
  "playerPos",
  "batter",
  "pitcher",
  "batterId",
  "pitcherId",
  "runnerId",
  "responsiblePitcherId",
  "first",
  "second",
  "third",
  "1",
  "2",
  "3",
  "away",
  "home",
  "ball",
  "strike",
  "out",
  "balls",
  "strikes",
  "outs",
  "base1",
  "base2",
  "base3",
  "bases",
  "awayScore",
  "homeScore",
  "score",
]);

export function focusedSourceEvidence(canonicalJson: string): string {
  try {
    const value: unknown = JSON.parse(canonicalJson);
    return JSON.stringify(pick(value, rowKeys), null, 2);
  } catch {
    return "요약할 수 없는 원문입니다. 전체 원문을 확인하세요.";
  }
}
function pick(value: unknown, keys: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry: unknown) => pick(entry, contextKeys));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => keys.has(key))
      .map(([key, entry]: [string, unknown]) => [key, pick(entry, contextKeys)]),
  );
}
