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
import { classifyTerminalRelay } from "./naver/terminal-relay.js";

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
  const terminalRows = classifyTerminalRelay(input.closeTrailingHalf ? rows : []);
  const excludedPitchIdsByBlock = new Map<number, Set<string>>();
  const findings: RelayNormalizationResult["findings"][number][] = [];
  for (const row of rows) {
    const note = terminalRows.get(row);
    const emitted = emitRelayRow(
      input.gameId,
      note === undefined
        ? row
        : {
            ...row,
            explicitKind: "administrative",
            administrativeCode: "announcement",
          },
      context,
    );
    const event = parseStagingRelayEvent({ ...emitted.event, sequence: events.length });
    events.push(event);
    findings.push(...emitted.findings);
    if (note !== undefined) {
      findings.push({
        lifecycle: "persistent",
        code: "source.terminal_relay_preserved",
        severity: "warning",
        message: note,
        endpoint: row.source.endpoint,
        blockIndex: row.source.endpointBlockIndex,
        rowIndex: row.rawIndex,
        eventId: event.identity.eventId,
        ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
        ...(row.relayText === null ? {} : { sourceText: row.relayText }),
      });
      if (row.sourcePitchId !== null) {
        const ids = excludedPitchIdsByBlock.get(row.source.sourceBlockIndex) ?? new Set<string>();
        ids.add(row.sourcePitchId);
        excludedPitchIdsByBlock.set(row.source.sourceBlockIndex, ids);
      }
    }
    updateNormalizationContext(row, event, context);
  }
  return {
    events: enrichCreditedRbi(enrichHitByPitchCalls(events)),
    findings,
    blocks,
    pitchEventIdsByBlock: context.pitchEventIdsByBlock,
    excludedPitchIdsByBlock,
  };
}
