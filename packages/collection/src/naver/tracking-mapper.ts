import {
  canonicalStringify,
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
  type TrackingCandidate,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { NaverSourceFormatError } from "../errors.js";
import type { NormalizedRelayBlock, RelayNormalizationResult } from "../relay-normalizer.js";
import type { SourceFinding } from "../types.js";
import {
  first,
  integer,
  optionalRecords,
  optionalText,
  parseHalf,
  type JsonRecord,
} from "./source-values.js";

export function mapNaverTrackingCandidates(
  gameId: string,
  normalized: Pick<
    RelayNormalizationResult,
    "blocks" | "events" | "pitchEventIdsByBlock" | "excludedPitchIdsByBlock"
  >,
): {
  readonly candidates: readonly TrackingCandidate[];
  readonly findings: readonly SourceFinding[];
} {
  const candidates: TrackingCandidate[] = [];
  const findings: SourceFinding[] = [];
  const eventById = new Map(normalized.events.map((event) => [event.identity.eventId, event]));

  for (const block of normalized.blocks) {
    const pitchEvents = normalized.pitchEventIdsByBlock.get(block.sourceBlockIndex);
    const blockCandidates: TrackingCandidate[] = [];
    for (const [trackingIndex, rawTracking] of optionalRecords(block.block.ptsOptions).entries()) {
      const rawSourcePitchId = optionalText(first(rawTracking, ["pitchId", "ptsPitchId"]));
      const sourcePitchId = rawSourcePitchId === "-1" ? null : rawSourcePitchId;
      const sourcePitchOrdinal = integer(first(rawTracking, ["ballcount", "ballCount"]));
      const pitcherId = optionalText(first(rawTracking, ["pitcherId", "pitcherCode"]));
      const batterId = optionalText(first(rawTracking, ["batterId", "batterCode"]));
      const sourceCandidates =
        sourcePitchId === null ? [] : (pitchEvents?.get(sourcePitchId) ?? []);
      const contextEvent = sourceCandidates
        .map((eventId) => eventById.get(eventId))
        .find((event) => event?.kind === "pitch");
      const sourceContext =
        contextEvent?.kind === "pitch"
          ? { inning: contextEvent.inning, half: contextEvent.half }
          : trackingBlockContext(block);
      const stance = optionalText(rawTracking.stance);
      if (stance !== null && stance !== "L" && stance !== "R" && stance !== "S") {
        findings.push(
          sourceFinding(
            "source.tracking.stance_unknown",
            "warning",
            "persistent",
            `알 수 없는 tracking 타석 방향입니다: ${stance}`,
            block.endpoint,
            block.endpointBlockIndex,
            trackingIndex,
          ),
        );
      }
      blockCandidates.push({
        trackingId: `${gameId}:${block.endpoint}:${String(block.endpointBlockIndex)}:${String(trackingIndex)}`,
        source: {
          endpoint: block.endpoint,
          blockIndex: block.endpointBlockIndex,
          rowIndex: trackingIndex,
        },
        ...(sourcePitchId === null ? {} : { sourcePitchId }),
        sourcePitchOrdinal:
          sourcePitchOrdinal === null || sourcePitchOrdinal < 1 ? null : sourcePitchOrdinal,
        sequence: candidates.length + blockCandidates.length,
        inning: sourceContext.inning,
        half: sourceContext.half,
        ...(pitcherId === null ? {} : { pitcherId }),
        ...(batterId === null ? {} : { batterId }),
        ...(stance === "L" || stance === "R" || stance === "S" ? { stance } : {}),
        ...trackingNumbers(rawTracking),
        resolution:
          sourcePitchId !== null &&
          sourceCandidates.length === 0 &&
          normalized.excludedPitchIdsByBlock?.get(block.sourceBlockIndex)?.has(sourcePitchId) ===
            true
            ? {
                kind: "excluded",
                reason: "not_a_pitch",
                note: "종료 뒤 완전히 일치하는 반복 중계의 관측값을 보존했습니다.",
              }
            : { kind: "pending" },
      });
    }
    resolveBlockTrackingCandidates(blockCandidates, pitchEvents, findings);
    candidates.push(...blockCandidates);
  }

  return { candidates, findings };
}

export function attachNaverTrackingPlateAppearanceContexts(
  document: StagingGameDocumentV2,
): StagingGameDocumentV2 {
  const replay = compileStagingGameDocumentV2(document);
  const plateAppearanceByPitchId = new Map(
    replay.pitchFacts.map((pitch) => [pitch.pitchId, pitch.plateAppearanceEventId]),
  );
  const candidatesById = new Map(
    document.trackingCandidates.map((candidate) => [candidate.trackingId, candidate]),
  );
  const trackingCandidates = document.trackingCandidates.map((candidate) => {
    const pitchEventId = resolvedPitchEventId(candidate, candidatesById);
    if (pitchEventId === null) return candidate;
    const plateAppearanceEventId = plateAppearanceByPitchId.get(pitchEventId);
    return plateAppearanceEventId === undefined || plateAppearanceEventId === null
      ? candidate
      : { ...candidate, plateAppearanceEventId };
  });
  return parseStagingGameDocumentV2({ ...document, trackingCandidates });
}

function trackingBlockContext(block: NormalizedRelayBlock): {
  readonly inning: number;
  readonly half: "top" | "bottom";
} {
  const inning = integer(first(block.block, ["inn", "inning"]));
  const half = parseHalf(first(block.block, ["homeOrAway", "half"]));
  if (inning === null || inning < 1 || inning > 99 || half === null) {
    throw new NaverSourceFormatError(
      `${block.endpoint} tracking 후보의 이닝 문맥을 확인할 수 없습니다.`,
    );
  }
  return { inning, half };
}

const trackingNumberKeys = [
  "x0",
  "y0",
  "z0",
  "vx0",
  "vy0",
  "vz0",
  "ax",
  "ay",
  "az",
  "crossPlateX",
  "crossPlateY",
] as const;

function trackingNumbers(
  row: JsonRecord,
): Partial<Pick<TrackingCandidate, (typeof trackingNumberKeys)[number]>> {
  const result: Partial<Record<(typeof trackingNumberKeys)[number], number>> = {};
  for (const key of trackingNumberKeys) {
    const value = finiteNumber(row[key]);
    if (value !== null) result[key] = value;
  }
  return result;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveBlockTrackingCandidates(
  candidates: TrackingCandidate[],
  pitchEventIdsBySourceId: ReadonlyMap<string, readonly string[]> | undefined,
  findings: SourceFinding[],
): void {
  const indexesBySourcePitchId = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.resolution.kind === "excluded") continue;
    const key = candidate.sourcePitchId;
    if (key === undefined) {
      findings.push(
        sourceFinding(
          "source.tracking.unlinked",
          "blocking",
          "recomputed",
          "tracking 관측값에 대응하는 원천 투구 ID가 없습니다.",
          candidate.source.endpoint,
          candidate.source.blockIndex,
          candidate.source.rowIndex,
        ),
      );
      continue;
    }
    const indexes = indexesBySourcePitchId.get(key) ?? [];
    indexes.push(index);
    indexesBySourcePitchId.set(key, indexes);
  }

  for (const [sourcePitchId, indexes] of indexesBySourcePitchId) {
    const pitchEventIds = pitchEventIdsBySourceId?.get(sourcePitchId) ?? [];
    const group = indexes.flatMap((index) => {
      const candidate = candidates[index];
      return candidate === undefined ? [] : [candidate];
    });
    if (pitchEventIds.length === group.length && group.length > 0) {
      for (const [occurrence, index] of indexes.entries()) {
        const candidate = candidates[index];
        const pitchEventId = pitchEventIds[occurrence];
        if (candidate === undefined || pitchEventId === undefined) continue;
        candidates[index] = linkTrackingCandidate(candidate, pitchEventId);
      }
      continue;
    }
    if (
      pitchEventIds.length === 1 &&
      group.length > 1 &&
      new Set(group.map(trackingFactFingerprint)).size === 1
    ) {
      const canonicalIndex = indexes[0];
      if (canonicalIndex === undefined) continue;
      const canonical = candidates[canonicalIndex];
      const pitchEventId = pitchEventIds[0];
      if (canonical === undefined || pitchEventId === undefined) continue;
      candidates[canonicalIndex] = linkTrackingCandidate(canonical, pitchEventId);
      for (const index of indexes.slice(1)) {
        const candidate = candidates[index];
        if (candidate === undefined) continue;
        candidates[index] = {
          ...candidate,
          resolution: { kind: "duplicate", canonicalTrackingId: canonical.trackingId },
        };
      }
      continue;
    }

    const conflict =
      pitchEventIds.length === 1 &&
      group.length > 1 &&
      new Set(group.map(trackingFactFingerprint)).size > 1;
    for (const candidate of group) {
      findings.push(
        sourceFinding(
          conflict
            ? "source.tracking.conflicting_candidates"
            : pitchEventIds.length === 0
              ? "source.tracking.unlinked"
              : "source.tracking.cardinality_mismatch",
          "blocking",
          "recomputed",
          conflict
            ? "하나의 원천 투구 행에 서로 다른 tracking 관측값이 있습니다."
            : pitchEventIds.length === 0
              ? "tracking 관측값에 대응하는 원천 투구 행이 없습니다."
              : `같은 block의 원천 투구 ${String(pitchEventIds.length)}개와 tracking ${String(group.length)}개의 개수가 다릅니다.`,
          candidate.source.endpoint,
          candidate.source.blockIndex,
          candidate.source.rowIndex,
        ),
      );
    }
  }
}

function linkTrackingCandidate(
  candidate: TrackingCandidate,
  pitchEventId: string,
): TrackingCandidate {
  return {
    ...candidate,
    resolution: { kind: "linked", pitchEventId },
  };
}

function resolvedPitchEventId(
  candidate: TrackingCandidate,
  candidatesById: ReadonlyMap<string, TrackingCandidate>,
): string | null {
  if (candidate.resolution.kind === "linked") return candidate.resolution.pitchEventId;
  if (candidate.resolution.kind !== "duplicate") return null;
  const canonical = candidatesById.get(candidate.resolution.canonicalTrackingId);
  return canonical?.resolution.kind === "linked" ? canonical.resolution.pitchEventId : null;
}

function trackingFactFingerprint(candidate: TrackingCandidate): string {
  const fact = Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) => !["trackingId", "source", "sequence", "resolution"].includes(key),
    ),
  );
  return canonicalStringify(fact);
}

function sourceFinding(
  code: string,
  severity: "warning" | "blocking",
  lifecycle: SourceFinding["lifecycle"],
  message: string,
  endpoint: string | null,
  blockIndex?: number,
  rowIndex?: number,
): SourceFinding {
  return {
    lifecycle,
    code,
    severity,
    message,
    endpoint,
    ...(blockIndex === undefined ? {} : { blockIndex }),
    ...(rowIndex === undefined ? {} : { rowIndex }),
  };
}
