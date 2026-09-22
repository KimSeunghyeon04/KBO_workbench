import {
  canonicalStringify,
  compareCanonicalStrings,
  parseGamePlayerHeightDataset,
  type GamePlayerHeightDataset,
  type PlayerHeightObservation,
} from "@kbo/contracts";
import { first, optionalText, record } from "./source-values.js";

/** Read identified player records, never PTS bounds or unrelated height fields. */
export function extractNaverPlayerHeights(input: {
  gameId: string;
  season: number;
  sourceBundleHash: string;
  payloads: Readonly<Record<string, unknown>>;
}): GamePlayerHeightDataset {
  const observations = new Map<string, PlayerHeightObservation>();
  function addPlayer(endpoint: string, sourcePath: string, raw: unknown): void {
    const row = record(raw);
    const playerId = optionalText(first(row, ["playerCode", "pcode"]));
    if (playerId === null) return;
    const rawHeight = optionalText(row.height);
    const height =
      rawHeight !== null && /^\d+(?:\.\d+)?$/.test(rawHeight) ? Number(rawHeight) : NaN;
    const heightCm = Number.isInteger(height) && height >= 100 && height <= 250 ? height : null;
    const key = canonicalStringify([playerId, rawHeight]);
    if (!observations.has(key))
      observations.set(key, { playerId, heightCm, rawHeight, endpoint, sourcePath });
  }
  function addRows(endpoint: string, sourcePath: string, value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const [index, raw] of value.entries())
      addPlayer(endpoint, `${sourcePath}[${index}].height`, raw);
  }
  for (const endpoint of Object.keys(input.payloads).sort(compareCanonicalStrings)) {
    const result = record(record(input.payloads[endpoint]).result);
    if (endpoint === "lineup") {
      const preview = record(result.previewData);
      for (const side of ["away", "home"]) {
        const lineup = record(preview[`${side}TeamLineUp`]);
        for (const group of ["fullLineUp", "batterCandidate", "pitcherBullpen"])
          addRows(endpoint, `result.previewData.${side}TeamLineUp.${group}`, lineup[group]);
        for (const group of ["starter", "bullpen", "bench"])
          addRows(endpoint, `result.previewData.${side}_${group}`, preview[`${side}_${group}`]);
      }
    } else if (endpoint === "relay_summary" || /^relay_\d{3}$/.test(endpoint)) {
      const relay = record(result.textRelayData);
      for (const side of ["away", "home"])
        for (const group of ["batter", "pitcher"])
          addRows(
            endpoint,
            `result.textRelayData.${side}Lineup.${group}`,
            record(relay[`${side}Lineup`])[group],
          );
      if (Array.isArray(relay.textRelays))
        for (const [blockIndex, block] of relay.textRelays.entries()) {
          const options = record(block).textOptions;
          if (!Array.isArray(options)) continue;
          for (const [rowIndex, option] of options.entries())
            for (const role of ["batterRecord", "pitcherRecord"])
              addPlayer(
                endpoint,
                `result.textRelayData.textRelays[${blockIndex}].textOptions[${rowIndex}].${role}.height`,
                record(option)[role],
              );
        }
    }
  }
  return parseGamePlayerHeightDataset({
    gameId: input.gameId,
    season: input.season,
    sourceBundleHash: input.sourceBundleHash,
    observations: [...observations.values()],
  });
}
