import type { Side } from "@kbo/contracts";

import { NaverSourceFormatError } from "../errors.js";
import {
  first,
  integer,
  optionalRecords,
  optionalText,
  record,
  requireText,
  type JsonRecord,
} from "./source-values.js";

export interface RosterDraft {
  readonly teamId: string;
  readonly players: Array<{
    playerId: string;
    name: string;
    battingOrder?: number;
    starter: boolean;
    positions: string[];
  }>;
}

export function mapNaverRoster(lineup: JsonRecord, side: Side, teamId: string): RosterDraft {
  const modern = record(lineup[`${side}TeamLineUp`]);
  const players: RosterDraft["players"] = [];
  if (Object.keys(modern).length > 0) {
    for (const row of optionalRecords(modern.fullLineUp)) players.push(rosterPlayer(row, true));
    for (const row of optionalRecords(modern.batterCandidate))
      players.push(rosterPlayer(row, false));
    for (const row of optionalRecords(modern.pitcherBullpen))
      players.push(rosterPlayer(row, false));
  } else {
    for (const row of optionalRecords(lineup[`${side}_starter`]))
      players.push(rosterPlayer(row, true));
    for (const row of optionalRecords(lineup[`${side}_bullpen`]))
      players.push(rosterPlayer(row, false));
    for (const row of optionalRecords(lineup[`${side}_bench`]))
      players.push(rosterPlayer(row, false));
  }
  const unique = new Map<string, RosterDraft["players"][number]>();
  for (const player of players) {
    const existing = unique.get(player.playerId);
    if (existing === undefined || (!existing.starter && player.starter))
      unique.set(player.playerId, player);
  }
  if (unique.size === 0) throw new NaverSourceFormatError(`${side} roster가 비어 있습니다.`);
  return { teamId, players: [...unique.values()] };
}

export function findNaverStartingPitcher(roster: RosterDraft): string | null {
  return (
    roster.players.find(
      (player) =>
        player.starter && player.positions.some((position) => /투수|선발|^1$|^P$/i.test(position)),
    )?.playerId ?? null
  );
}

function rosterPlayer(row: JsonRecord, starter: boolean): RosterDraft["players"][number] {
  const playerId = requireText(first(row, ["playerCode", "pcode"]), "선수 ID");
  const name = requireText(first(row, ["playerName", "name"]), "선수 이름");
  const battingOrder = integer(first(row, ["batorder", "batOrder"]));
  const position = optionalText(first(row, ["positionName", "position", "pos"]));
  return {
    playerId,
    name,
    ...(battingOrder === null || battingOrder < 1 || battingOrder > 9 ? {} : { battingOrder }),
    starter,
    positions: position === null ? [] : [position],
  };
}
