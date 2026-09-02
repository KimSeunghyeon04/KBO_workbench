import {
  canonicalStringify,
  type CorrectionSourceEvidence,
  type StagingRelayEvent,
} from "@kbo/contracts";

export interface NaverSourceEvidenceInput {
  readonly event: StagingRelayEvent;
  readonly payloads: Readonly<Record<string, unknown>>;
}

export class NaverSourceEvidenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NaverSourceEvidenceError";
  }
}

export function extractNaverSourceEvidence(
  input: NaverSourceEvidenceInput,
): CorrectionSourceEvidence {
  const { event } = input;
  if (event.identity.kind !== "source") {
    throw new NaverSourceEvidenceError("수동 추가 원장 행에는 immutable source가 없습니다.");
  }
  const identity = event.identity;
  const blocks = relayBlocks(input.payloads[identity.endpoint]);
  const block = objectAt(blocks, identity.blockIndex, "relay block");
  const relayRows = objectArray(block.textOptions ?? block.events, "relay rows");
  if (relayRows[identity.eventIndex] === undefined) {
    throw new NaverSourceEvidenceError("immutable source에서 선택한 원천 행을 찾지 못했습니다.");
  }
  const firstRow = Math.max(0, identity.eventIndex - 2);
  const lastRow = Math.min(relayRows.length, identity.eventIndex + 3);
  const sourcePitchId = event.kind === "pitch" ? (event.payload.sourcePitchId ?? null) : null;
  const trackingRows = objectArrayOptional(block.ptsOptions ?? block.tracking);
  return {
    eventId: identity.eventId,
    endpoint: identity.endpoint,
    blockIndex: identity.blockIndex,
    eventIndex: identity.eventIndex,
    relayRows: relayRows.slice(firstRow, lastRow).map((row, offset) => ({
      rowIndex: firstRow + offset,
      sourceSequence: integerValue(row.seqno ?? row.seqNo),
      selected: firstRow + offset === identity.eventIndex,
      canonicalJson: canonicalStringify(row),
    })),
    trackingRows: trackingRows.flatMap((row, rowIndex) => {
      const candidatePitchId = textValue(
        row.pitchId ?? row.ptsPitchId ?? row.sourcePitchId ?? row.source_pitch_id,
      );
      if (sourcePitchId === null || candidatePitchId !== sourcePitchId) return [];
      return [
        { rowIndex, sourcePitchId: candidatePitchId, canonicalJson: canonicalStringify(row) },
      ];
    }),
  };
}

function relayBlocks(value: unknown): readonly Record<string, unknown>[] {
  let current = recordValue(value, "source endpoint");
  if (current.result !== undefined) current = recordValue(current.result, "source result");
  if (current.textRelayData !== undefined) {
    current = recordValue(current.textRelayData, "source textRelayData");
  }
  return objectArray(current.textRelays, "source textRelays");
}

function objectAt(
  values: readonly Record<string, unknown>[],
  index: number,
  label: string,
): Record<string, unknown> {
  const value = values[index];
  if (value === undefined) throw new NaverSourceEvidenceError(`${label}을 찾지 못했습니다.`);
  return value;
}

function objectArray(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new NaverSourceEvidenceError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function objectArrayOptional(value: unknown): readonly Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  return objectArray(value, "source tracking rows");
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new NaverSourceEvidenceError(`${label} 형식이 올바르지 않습니다.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "" && value !== "-1") return value;
  if (typeof value === "number" && Number.isFinite(value) && value !== -1) return String(value);
  return null;
}

function integerValue(value: unknown): number | null {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof numeric === "number" && Number.isInteger(numeric) ? numeric : null;
}
