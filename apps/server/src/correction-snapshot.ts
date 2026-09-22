import {
  canonicalStringify,
  parseStagingGameDocumentV2,
  type CorrectionFinding,
  type CorrectionSession,
  type StagingGameDocumentV2,
  type StoredFinding,
} from "@kbo/contracts";
import { stagingDocumentHash, type GameState, type ReplayResult } from "@kbo/game-core";
export type PreparedCorrectionSnapshot = Pick<
  CorrectionSession,
  | "draftDocumentHash"
  | "draftDocument"
  | "storedFindings"
  | "findings"
  | "eventContexts"
  | "calculatedRecords"
  | "blockingCount"
  | "warningCount"
>;
function parseSessionDocument(value: unknown): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2(JSON.parse(canonicalStringify(value)) as unknown);
}
export function prepareCorrectionSnapshot(
  document: StagingGameDocumentV2,
  replay: ReplayResult,
  storedFindings: readonly StoredFinding[],
): PreparedCorrectionSnapshot {
  const currentFindings = mergePersistentSourceFindings(storedFindings, replay.findings, document);
  const pitchFacts = new Map(replay.pitchFacts.map((pitch) => [pitch.pitchId, pitch]));
  const runnerMovements = new Map(
    replay.plays.flatMap((play) =>
      play.movements.flatMap((movement) =>
        movement.sourceEventId === null ? [] : [[movement.sourceEventId, movement] as const],
      ),
    ),
  );
  const result: PreparedCorrectionSnapshot = {
    draftDocumentHash: stagingDocumentHash(document),
    draftDocument: parseSessionDocument(document),
    storedFindings: storedFindings.map((finding) =>
      storedFindingSnapshot(document.metadata.gameId, finding),
    ),
    findings: currentFindings.map((finding) =>
      storedFindingSnapshot(document.metadata.gameId, finding),
    ),
    eventContexts: replay.frames.map((frame) => {
      const pitch = pitchFacts.get(frame.eventId);
      const movement = runnerMovements.get(frame.eventId);
      return {
        eventId: frame.eventId,
        applied: frame.applied,
        before: correctionState(frame.before),
        after: correctionState(frame.after),
        ...(movement === undefined || !frame.applied
          ? {}
          : {
              runnerMovement: {
                runnerId: movement.runnerId,
                responsiblePitcherId: movement.responsiblePitcherId,
              },
            }),
        ...(pitch === undefined
          ? {}
          : {
              pitch: {
                plateAppearanceEventId: pitch.plateAppearanceEventId,
                pitchEventNumber: pitch.pitchEventNumber,
                actualPitchNumber: pitch.actualPitchNumber,
                batterId: pitch.batterId,
                pitcherId: pitch.pitcherId,
                sourcePitchId: pitch.sourcePitchId,
                call: pitch.call,
                actual: pitch.actual,
              },
            }),
      };
    }),
    calculatedRecords: {
      batters: replay.batterLines.map((line) => ({ ...line })),
      pitchers: replay.pitcherLines.map((line) => ({ ...line })),
    },
    blockingCount: currentFindings.filter((finding) => finding.severity === "blocking").length,
    warningCount: currentFindings.filter((finding) => finding.severity === "warning").length,
  };
  return result;
}
function storedFindingSnapshot(gameId: string, finding: StoredFinding): CorrectionFinding {
  return {
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    gameId: finding.gameId ?? gameId,
    ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
    ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
    ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
    details: [
      ...(finding.endpoint === undefined ? [] : [{ field: "endpoint", actual: finding.endpoint }]),
      ...(finding.details ?? []).map((detail) => ({ ...detail })),
    ],
  };
}

export function mergePersistentSourceFindings(
  stored: readonly StoredFinding[],
  current: ReplayResult["findings"],
  document: StagingGameDocumentV2,
): StoredFinding[] {
  const findings: StoredFinding[] = [
    ...stored.filter((finding) => shouldRetainStoredFinding(finding, document)),
    ...current.map((finding) => ({
      producer: "compiler" as const,
      lifecycle: "recomputed" as const,
      code: finding.code,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
      ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
      ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
      ...(finding.details.length === 0
        ? {}
        : { details: finding.details.map((detail) => ({ ...detail })) }),
    })),
  ];
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = canonicalStringify(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function shouldRetainStoredFinding(
  finding: StoredFinding,
  document: StagingGameDocumentV2,
): boolean {
  if (finding.lifecycle === "persistent") return true;
  if (finding.lifecycle === "while_event_unresolved" && finding.eventId !== undefined) {
    return document.events.some(
      (event) => event.identity.eventId === finding.eventId && event.kind === "unresolved",
    );
  }
  return false;
}
function correctionState(state: GameState): CorrectionSession["eventContexts"][number]["after"] {
  return {
    balls: state.balls,
    strikes: state.strikes,
    outs: state.outs,
    bases: state.bases.map((base) => base?.runnerId ?? null),
    awayScore: state.awayScore,
    homeScore: state.homeScore,
    batterId: state.activePlateAppearance?.currentBatterId ?? null,
    pitcherId: state.activePlateAppearance?.currentPitcherId ?? null,
  };
}
