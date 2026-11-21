import type { PlateResult, StagingRelayEvent } from "@kbo/contracts";

import { isCoarseGroundBallReach } from "./lexicon.js";
import type { CanonicalNaverRow } from "./model.js";
import { hitKind, splitNaverInningResults } from "./official-extra-base-hits.js";
import { first, optionalRecords, optionalText, record, type JsonRecord } from "./source-values.js";

type ResultEvent = Extract<StagingRelayEvent, { kind: "plate_result" }>;
type BoxscoreResult = PlateResult | "ground_ball";
type Appearance = { readonly event: ResultEvent; readonly coarseReach: boolean };

export function reconcileBoxscorePlateResults(
  events: readonly StagingRelayEvent[],
  relayRows: readonly CanonicalNaverRow[],
  recordValue: JsonRecord,
): readonly StagingRelayEvent[] {
  const groups = new Map<string, Appearance[]>();
  const unresolvedHalves = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.kind === "unresolved" && event.payload.suspectedKind === "plate_result") {
      unresolvedHalves.add(`${event.half}:${event.inning}`);
    }
    if (event.kind !== "plate_result") continue;
    const side = event.half === "top" ? "away" : "home";
    const key = `${side}:${event.payload.batterId}:${event.inning}`;
    const appearances = groups.get(key) ?? [];
    const source = relayRows[index];
    appearances.push({
      event,
      coarseReach:
        event.payload.result === "fielder_choice" &&
        source !== undefined &&
        isCoarseGroundBallReach(source),
    });
    groups.set(key, appearances);
  }

  const overrides = new Set<string>();
  const boxscore = record(first(recordValue, ["battersBoxscore", "batter", "batters"]));
  for (const side of ["away", "home"] as const) {
    const half = side === "away" ? "top" : "bottom";
    const byPlayer = indexBoxscoreRows(boxscore[side]);
    for (const [playerId, playerRows] of byPlayer) {
      if (playerRows.length !== 1) continue;
      for (const [cell, raw] of Object.entries(playerRows[0] ?? {})) {
        if (!/^inn[1-9]\d*$/.test(cell) || typeof raw !== "string" || !raw.trim()) continue;
        const inning = cell.slice(3);
        if (unresolvedHalves.has(`${half}:${inning}`)) continue;
        const appearances = groups.get(`${side}:${playerId}:${inning}`);
        if (appearances === undefined || !appearances.some((item) => item.coarseReach)) continue;
        const tokens = splitNaverInningResults(raw).map(boxscoreResult);
        if (
          tokens.length !== appearances.length ||
          !appearances.every((item, index) => matchesEvidence(item, tokens[index]))
        ) {
          continue;
        }
        for (const [index, item] of appearances.entries()) {
          if (item.coarseReach && tokens[index] === "reached_on_error") {
            overrides.add(item.event.identity.eventId);
          }
        }
      }
    }
  }
  if (overrides.size === 0) return events;
  return events.map((event) =>
    event.kind === "plate_result" && overrides.has(event.identity.eventId)
      ? { ...event, payload: { ...event.payload, result: "reached_on_error" } }
      : event,
  );
}

function indexBoxscoreRows(input: unknown): ReadonlyMap<string, readonly JsonRecord[]> {
  const byPlayer = new Map<string, JsonRecord[]>();
  for (const row of optionalRecords(input)) {
    const playerId = optionalText(first(row, ["playerCode", "pcode", "playerId"]));
    if (playerId === null) continue;
    const rows = byPlayer.get(playerId) ?? [];
    rows.push(row);
    byPlayer.set(playerId, rows);
  }
  return byPlayer;
}

function matchesEvidence(appearance: Appearance, token: BoxscoreResult | null | undefined) {
  const result = appearance.event.payload.result;
  if (result === token) return true;
  if (token === "ground_ball") {
    return result === "fielder_choice" || result === "field_out";
  }
  return appearance.coarseReach && token === "reached_on_error";
}

function boxscoreResult(token: string): BoxscoreResult | null {
  const hit = hitKind(token);
  if (hit !== "non_hit") return hit;
  if (/^[1-9투포유좌중우]실$/.test(token)) return "reached_on_error";
  if (/^[1-9투포유좌중우]땅$/.test(token)) return "ground_ball";
  if (/^[1-9투포유좌중우](?:비|직|파)$/.test(token)) return "field_out";
  if (token === "야선") return "fielder_choice";
  if (token === "4구") return "walk";
  if (token === "고4") return "intentional_walk";
  if (token === "사구") return "hit_by_pitch";
  if (/^(?:삼진|스낫|삼파|삼번)$/.test(token)) return "strikeout";
  return null;
}
