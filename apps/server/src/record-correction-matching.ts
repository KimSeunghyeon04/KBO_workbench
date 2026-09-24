import { createHash } from "node:crypto";
import {
  canonicalStringify,
  type RecordCorrectionMatchCandidate,
  type RecordCorrectionNotice,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import type { RecordCorrectionGameCandidate } from "@kbo/persistence";

export function matchPlateAppearances(
  notice: RecordCorrectionNotice,
  game: RecordCorrectionGameCandidate,
  document: StagingGameDocumentV2,
): RecordCorrectionMatchCandidate[] {
  const battingSide = notice.half === "top" ? "away" : "home";
  const pitchingSide = battingSide === "away" ? "home" : "away";
  const batterParticipant =
    notice.participants.find((participant) => participant.role === "batter") ??
    notice.participants[0];
  const pitcherParticipants = notice.participants.filter(
    (participant) => participant.role === "pitcher",
  );
  if (batterParticipant === undefined || pitcherParticipants.length === 0) return [];
  const batters = document.rosters[battingSide].players.filter(
    (player) => player.name === batterParticipant.rawPlayerName,
  );
  const pitchers = document.rosters[pitchingSide].players.filter((player) =>
    pitcherParticipants.some((participant) => player.name === participant.rawPlayerName),
  );
  if (batters.length === 0 || pitchers.length === 0) return [];
  const replay = compileStagingGameDocumentV2(document);
  return batters.flatMap((batter) =>
    pitchers.flatMap((pitcher) =>
      replay.plateAppearances
        .filter(
          (plateAppearance) =>
            plateAppearance.inning === notice.inning &&
            plateAppearance.half === notice.half &&
            plateAppearance.batterId === batter.playerId &&
            plateAppearance.pitcherId === pitcher.playerId &&
            plateAppearance.completed &&
            plateAppearance.endEventId !== null,
        )
        .flatMap((plateAppearance) => {
          const eventId = plateAppearance.endEventId;
          if (eventId === null) return [];
          if (
            battingOrderAt(document, battingSide, batter.playerId, eventId) !== notice.battingOrder
          )
            return [];
          return [
            {
              candidateId: `candidate:${createHash("sha256")
                .update(
                  canonicalStringify([
                    game.gameId,
                    game.revision,
                    eventId,
                    batter.playerId,
                    pitcher.playerId,
                  ]),
                  "utf8",
                )
                .digest("hex")}`,
              gameId: game.gameId,
              revision: game.revision,
              documentHash: game.documentHash,
              eventId,
              batterPlayerId: batter.playerId,
              pitcherPlayerId: pitcher.playerId,
              label: `${game.gameId} · ${notice.gameDate} ${notice.inning}회 ${notice.half === "top" ? "초" : "말"} ${batter.name}(${batter.playerId}) / ${pitcher.name}(${pitcher.playerId})`,
              confidenceReason:
                batters.length === 1 &&
                pitchers.filter((player) => player.name === pitcher.name).length === 1
                  ? "날짜·원정/홈 팀·이닝·초말·타순·타자·투수가 모두 일치합니다."
                  : "동명이인 후보입니다. 선수 ID를 확인해 수동 선택해야 합니다.",
            },
          ];
        }),
    ),
  );
}

function battingOrderAt(
  document: StagingGameDocumentV2,
  side: "away" | "home",
  playerId: string,
  eventId: string,
): number | undefined {
  const orders = new Map<string, number>();
  for (const player of document.rosters[side].players) {
    if (player.battingOrder !== undefined) orders.set(player.playerId, player.battingOrder);
  }
  for (const event of document.events) {
    if (event.identity.eventId === eventId) return orders.get(playerId);
    if (event.kind !== "substitution" || event.payload.side !== side) continue;
    const { incomingPlayerId, outgoingPlayerId, battingOrder } = event.payload;
    // Position-only changes retain the slot inherited by an earlier pinch runner/hitter.
    const order =
      battingOrder ?? (outgoingPlayerId === undefined ? undefined : orders.get(outgoingPlayerId));
    if (order !== undefined) orders.set(incomingPlayerId, order);
  }
  return undefined;
}
