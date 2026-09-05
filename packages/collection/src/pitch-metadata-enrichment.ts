import { canonicalStringify, type PitchEvent, type StagingGameDocumentV2 } from "@kbo/contracts";

import { hashRawGameBundle } from "./mapper.js";
import { parseNaverPitchMetadata } from "./naver/pitch-metadata.js";
import { decodeRelayRows } from "./naver/source-pipeline.js";
import { isRecord, record } from "./naver/source-values.js";
import type { CanonicalNaverRow } from "./naver/model.js";
import type { RawGameBundle, SourceFinding } from "./types.js";

export interface PitchMetadataEnrichmentIssue {
  readonly eventId: string;
  readonly reason:
    "manual" | "source_missing" | "source_mismatch" | "metadata_missing" | "value_conflict";
  readonly endpoint?: string;
  readonly blockIndex?: number;
  readonly rowIndex?: number;
  readonly field?: "speedKph" | "pitchType";
}
export interface PitchMetadataEnrichment {
  readonly replacements: readonly PitchEvent[];
  readonly findings: readonly SourceFinding[];
  readonly issues: readonly PitchMetadataEnrichmentIssue[];
}

/** Enrich the corrected ledger by immutable row location, never by non-unique pitch ID. */
export function buildNaverPitchMetadataEnrichment(
  document: StagingGameDocumentV2,
  bundle: RawGameBundle,
): PitchMetadataEnrichment {
  if (
    bundle.gameId !== document.metadata.gameId ||
    hashRawGameBundle(bundle) !== document.source.sourceBundleHash
  ) {
    throw new Error("구속·구종 보완 source bundle hash 또는 game ID가 다릅니다.");
  }
  const replacements: PitchEvent[] = [];
  const findings: SourceFinding[] = [];
  const issues: PitchMetadataEnrichmentIssue[] = [];
  const blocks = new Map<string, ReadonlyMap<number, CanonicalNaverRow>>();
  for (const event of document.events) {
    if (event.kind !== "pitch") continue;
    const identity = event.identity;
    const eventId = identity.eventId;
    if (identity.kind === "manual") {
      issues.push({ eventId, reason: "manual" });
      continue;
    }
    const location = {
      eventId,
      endpoint: identity.endpoint,
      blockIndex: identity.blockIndex,
      rowIndex: identity.eventIndex,
    };
    const blockKey = canonicalStringify([identity.endpoint, identity.blockIndex]);
    let rows = blocks.get(blockKey);
    if (rows === undefined) {
      let envelope = record(bundle.payloads[identity.endpoint]);
      if (envelope.result !== undefined) envelope = record(envelope.result);
      if (envelope.textRelayData !== undefined) envelope = record(envelope.textRelayData);
      const rawBlocks = envelope.textRelays;
      const rawBlock: unknown = Array.isArray(rawBlocks)
        ? rawBlocks[identity.blockIndex]
        : undefined;
      if (!isRecord(rawBlock)) {
        issues.push({ ...location, reason: "source_missing" });
        continue;
      }
      rows = new Map(
        decodeRelayRows([
          {
            endpoint: identity.endpoint,
            endpointBlockIndex: identity.blockIndex,
            sourceBlockIndex: identity.blockIndex,
            block: rawBlock,
          },
        ]).map((row) => [row.rawIndex, row]),
      );
      blocks.set(blockKey, rows);
    }
    const row = rows.get(identity.eventIndex);
    if (row === undefined) {
      issues.push({ ...location, reason: "source_missing" });
      continue;
    }
    if (
      row.inning !== event.inning ||
      row.half !== event.half ||
      (identity.sourceEventId !== undefined && identity.sourceEventId !== row.sourceEventId) ||
      (event.payload.sourcePitchId !== undefined &&
        event.payload.sourcePitchId !== row.sourcePitchId) ||
      (event.payload.batterId !== undefined &&
        (row.batterId ?? row.observedState.batterId) !== null &&
        event.payload.batterId !== (row.batterId ?? row.observedState.batterId)) ||
      (event.payload.pitcherId !== undefined &&
        (row.pitcherId ?? row.observedState.pitcherId) !== null &&
        event.payload.pitcherId !== (row.pitcherId ?? row.observedState.pitcherId))
    ) {
      issues.push({ ...location, reason: "source_mismatch" });
      continue;
    }
    const parsed = parseNaverPitchMetadata(row.pitchSpeed, row.pitchType, {
      ...location,
      ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
      ...(row.relayText === null ? {} : { sourceText: row.relayText }),
    });
    findings.push(...parsed.findings);
    const payload = { ...event.payload };
    for (const field of ["speedKph", "pitchType"] as const) {
      if (
        payload[field] !== undefined &&
        parsed.metadata[field] !== undefined &&
        payload[field] !== parsed.metadata[field]
      ) {
        issues.push({ ...location, reason: "value_conflict", field });
      }
    }
    if (payload.speedKph === undefined && parsed.metadata.speedKph !== undefined)
      payload.speedKph = parsed.metadata.speedKph;
    if (payload.pitchType === undefined && parsed.metadata.pitchType !== undefined)
      payload.pitchType = parsed.metadata.pitchType;
    if (canonicalStringify(payload) !== canonicalStringify(event.payload))
      replacements.push({ ...event, payload });
    if (parsed.metadata.speedKph === undefined && parsed.metadata.pitchType === undefined)
      issues.push({ ...location, reason: "metadata_missing" });
  }
  return { replacements, findings, issues };
}
