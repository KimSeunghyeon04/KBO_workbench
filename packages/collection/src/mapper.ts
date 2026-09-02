import { createHash } from "node:crypto";

import { canonicalStringify, parseStagingGameDocumentV2 } from "@kbo/contracts";

import { NaverSourceFormatError } from "./errors.js";
import {
  decodeNaverGameDate,
  decodeNaverGameMetadata,
  endpointPayload,
} from "./naver/game-metadata.js";
import { mapNaverOfficialRecords } from "./naver/official-record-mapper.js";
import { findNaverStartingPitcher, mapNaverRoster } from "./naver/roster-mapper.js";
import {
  attachNaverTrackingPlateAppearanceContexts,
  mapNaverTrackingCandidates,
} from "./naver/tracking-mapper.js";
import {
  normalizeNaverRelay,
  type RelayBlockInput,
  type RelayRosterPlayer,
} from "./relay-normalizer.js";
import { optionalText, requireRecords as arrayOfRecords } from "./naver/source-values.js";
import type { MappingResult, RawGameBundle } from "./types.js";

export function mapNaverGame(bundle: RawGameBundle): MappingResult {
  const {
    lineup,
    gameInfo,
    gameDate,
    scheduledAt,
    status,
    awayTeamId,
    awayName,
    homeTeamId,
    homeName,
  } = decodeNaverGameMetadata(bundle);
  const awayRoster = mapNaverRoster(lineup, "away", awayTeamId);
  const homeRoster = mapNaverRoster(lineup, "home", homeTeamId);
  const startingPitchers = {
    away: findNaverStartingPitcher(awayRoster),
    home: findNaverStartingPitcher(homeRoster),
  };
  const relays = Object.entries(bundle.payloads)
    .filter(([key]) => /^relay_\d{3}$/.test(key))
    .sort(([left], [right]) => compareText(left, right));
  if (relays.length === 0) {
    throw new NaverSourceFormatError("수집 bundle에 이닝별 relay가 없습니다.");
  }
  const relayBlocks: RelayBlockInput[] = [];
  for (const [relayName, rawRelay] of relays) {
    const relay = endpointPayload(rawRelay, "textRelayData", relayName);
    const blocks = arrayOfRecords(relay.textRelays, `${relayName}.textRelays`);
    for (const [blockIndex, block] of blocks.entries()) {
      relayBlocks.push({ endpoint: relayName, endpointBlockIndex: blockIndex, block });
    }
  }
  const players: RelayRosterPlayer[] = [
    ...awayRoster.players.map((player) => ({ ...player, side: "away" as const })),
    ...homeRoster.players.map((player) => ({ ...player, side: "home" as const })),
  ];
  const normalized = normalizeNaverRelay({
    gameId: bundle.gameId,
    blocks: relayBlocks,
    players,
    startingPitchers,
    closeTrailingHalf: status === "final",
  });
  const tracking = mapNaverTrackingCandidates(bundle.gameId, normalized);
  const findings = [...normalized.findings, ...tracking.findings];

  const recordPayload = endpointPayload(bundle.payloads.record, "recordData", "record");
  const officialRecords = mapNaverOfficialRecords(recordPayload);
  const mappedDocument = parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: bundle.gameId,
      collectedAt: bundle.collectedAt,
      sourceBundleHash: hashRawGameBundle(bundle),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: bundle.gameId,
      season: Number(gameDate.slice(0, 4)),
      gameDate,
      scheduledAt,
      status,
      ...(optionalText(gameInfo.stadium) === null
        ? {}
        : { stadium: optionalText(gameInfo.stadium) }),
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: awayTeamId, name: awayName },
      home: { teamId: homeTeamId, name: homeName },
    },
    rosters: { away: awayRoster, home: homeRoster },
    events: normalized.events,
    trackingCandidates: tracking.candidates,
    officialRecords,
  });
  const document = attachNaverTrackingPlateAppearanceContexts(mappedDocument);
  return { document, findings };
}

export function sourceSeasonFromNaverBundle(bundle: RawGameBundle): number {
  const gameDate = decodeNaverGameDate(bundle);
  const season = Number(gameDate.slice(0, 4));
  if (!Number.isInteger(season) || season < 1982) {
    throw new NaverSourceFormatError("경기 날짜에서 season을 확인할 수 없습니다.");
  }
  return season;
}

export function hashRawGameBundle(bundle: RawGameBundle): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        gameId: bundle.gameId,
        missingEndpoints: [...bundle.missingEndpoints].sort(compareText),
        payloads: bundle.payloads,
      }),
      "utf8",
    )
    .digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
