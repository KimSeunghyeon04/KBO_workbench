import { parseStagingRelayEvent, type Side, type StagingRelayEvent } from "@kbo/contracts";

import { emitRelayRow } from "./naver/event-emitter.js";
import { enrichHitByPitchCalls } from "./naver/hit-by-pitch-enrichment.js";
import type {
  NormalizedRelayBlock,
  RelayBlockInput,
  RelayNormalizationResult,
  RelayRosterPlayer,
} from "./naver/model.js";
import { createParseContext, updateNormalizationContext } from "./naver/normalization-context.js";
import { createPlayerIndex } from "./naver/player-resolver.js";
import { enrichCreditedRbi } from "./naver/rbi-enrichment.js";
import { decodeRelayRows, prepareRelayBlocks } from "./naver/source-pipeline.js";

export type {
  NormalizedRelayBlock,
  RelayBlockInput,
  RelayNormalizationResult,
  RelayRosterPlayer,
} from "./naver/model.js";

export function normalizeNaverRelay(input: {
  readonly gameId: string;
  readonly blocks: readonly RelayBlockInput[];
  readonly players: readonly RelayRosterPlayer[];
  readonly startingPitchers: Readonly<Record<Side, string | null>>;
  readonly closeTrailingHalf: boolean;
}): RelayNormalizationResult {
  const blocks: readonly NormalizedRelayBlock[] = prepareRelayBlocks(input.blocks);
  const players = createPlayerIndex(input.players);
  const rows = decodeRelayRows(blocks);
  const context = createParseContext(players, input.startingPitchers);
  const events: StagingRelayEvent[] = [];
  const findings: RelayNormalizationResult["findings"][number][] = [];
  for (const row of rows) {
    const emitted = emitRelayRow(input.gameId, row, context);
    const event = parseStagingRelayEvent({ ...emitted.event, sequence: events.length });
    events.push(event);
    findings.push(...emitted.findings);
    updateNormalizationContext(row, event, context);
  }
  void input.closeTrailingHalf;
  return {
    events: enrichCreditedRbi(enrichHitByPitchCalls(events)),
    findings,
    blocks,
    pitchEventIdsByBlock: context.pitchEventIdsByBlock,
  };
}
