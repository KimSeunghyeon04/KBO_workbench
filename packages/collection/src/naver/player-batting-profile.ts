import {
  canonicalStringify,
  compareCanonicalStrings,
  parseGamePlayerBattingProfileDataset,
  type GamePlayerBattingProfileDataset,
  type PlayerBattingProfileObservation,
} from "@kbo/contracts";
import { first, optionalText, record } from "./source-values.js";

/** A player's declared batting side is independent of whether a pitch has PTS. */
export function extractNaverPlayerBattingProfiles(input: {
  gameId: string;
  season: number;
  sourceBundleHash: string;
  payloads: Readonly<Record<string, unknown>>;
}): GamePlayerBattingProfileDataset {
  const observations = new Map<string, PlayerBattingProfileObservation>();
  function addPlayer(endpoint: string, sourcePath: string, raw: unknown): void {
    const row = record(raw);
    const playerId = optionalText(first(row, ["playerCode", "pcode"]));
    if (playerId === null) return;
    for (const field of ["batsThrows", "hitType"]) {
      const rawValue = optionalText(row[field]);
      if (rawValue === null) continue;
      const side = /^(?:[좌우양]투)?(좌타|우타|양타)$/.exec(rawValue.replace(/\s/g, ""))?.[1];
      const battingSide =
        side === "좌타" ? "L" : side === "우타" ? "R" : side === "양타" ? "S" : null;
      const key = canonicalStringify([playerId, field, rawValue]);
      if (!observations.has(key))
        observations.set(key, {
          playerId,
          battingSide,
          rawValue,
          endpoint,
          sourcePath: `${sourcePath}.${field}`,
        });
    }
  }
  function addRows(endpoint: string, path: string, value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const [index, row] of value.entries()) addPlayer(endpoint, `${path}[${index}]`, row);
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
                `result.textRelayData.textRelays[${blockIndex}].textOptions[${rowIndex}].${role}`,
                record(option)[role],
              );
        }
    }
  }
  return parseGamePlayerBattingProfileDataset({
    gameId: input.gameId,
    season: input.season,
    sourceBundleHash: input.sourceBundleHash,
    observations: [...observations.values()],
  });
}
