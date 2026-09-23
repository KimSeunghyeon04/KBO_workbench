import { extractNaverPlayerHeights } from "@kbo/collection";
import { applyCorrectionCommand, buildRecordCorrectionBatchProposal } from "@kbo/correction";
import {
  compileStagingGameDocumentV2,
  summarizePitchQuality,
  summarizeMatchupModel,
  analyzePitchAngles,
  comparePitcherWorkload,
  trainParkEnvironment,
} from "@kbo/game-core";
import {
  trainPitchQualityFromFacts,
  preparePitchAnalysisReference,
  calculatePitchAnalysisSample,
  calculatePitchCalibration,
  readImmutableSourceBundle,
  buildRelationalProjection,
  hashProjectionTables,
} from "@kbo/persistence";
import type { Computation, ComputationResult } from "./computation-protocol.js";

const { computeRunModel }: typeof import("./run-model-computation.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./run-model-computation.ts" : "./run-model-computation.js",
    import.meta.url,
  ).href
);
const { SourceEvidenceComputer }: typeof import("./source-evidence-computation.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./source-evidence-computation.ts"
      : "./source-evidence-computation.js",
    import.meta.url,
  ).href
);
const sourceEvidence = new SourceEvidenceComputer();
const { prepareCorrectionSnapshot }: typeof import("./correction-snapshot.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./correction-snapshot.ts" : "./correction-snapshot.js",
    import.meta.url,
  ).href
);
const { projectNaverSourceBundle }: typeof import("./source-projection.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./source-projection.ts" : "./source-projection.js",
    import.meta.url,
  ).href
);

export function compute(input: Computation): ComputationResult | Promise<ComputationResult> {
  switch (input.kind) {
    case "workload_comparison":
      return {
        kind: input.kind,
        value: comparePitcherWorkload(
          input.query,
          input.scope,
          input.pitcherId,
          input.sourceHash,
          input.history,
          input.cells,
        ),
      };
    case "pitch_angles":
      return {
        kind: input.kind,
        value: analyzePitchAngles(input.rows, input.scope, input.pitcherId, input.sourceHash),
      };
    case "matchup_summary":
      return {
        kind: input.kind,
        value: summarizeMatchupModel(
          input.query,
          input.scope,
          input.sourceHash,
          input.pitcherRows,
          input.batterRows,
          input.model,
          input.modelHash,
        ),
      };
    case "pitch_quality_model":
      return {
        kind: input.kind,
        value: trainPitchQualityFromFacts(input.rows, input.sourceHash, input.through),
      };
    case "pitch_quality_summary":
      return {
        kind: input.kind,
        value: summarizePitchQuality(
          input.rows,
          input.scope,
          input.pitcherId,
          input.sourceHash,
          input.model,
          input.modelHash,
        ),
      };
    case "park_model":
      return {
        kind: "park_model",
        value: trainParkEnvironment(input.rows, input.sourceHash, input.through),
      };
    case "run_model":
      return { kind: "run_model", value: computeRunModel(input) };
    case "warmup":
      return { kind: "warmup", value: null };
    case "source_evidence":
      return sourceEvidence.run(input).then((value) => ({ kind: "source_evidence", value }));
    case "compile": {
      const value = compileStagingGameDocumentV2(input.document);
      return {
        kind: input.kind,
        value,
        ...(input.storedFindings === undefined
          ? {}
          : { snapshot: prepareCorrectionSnapshot(input.document, value, input.storedFindings) }),
      };
    }
    case "command": {
      const value = applyCorrectionCommand(input.document, input.command);
      return {
        kind: input.kind,
        value,
        ...(input.storedFindings === undefined
          ? {}
          : {
              snapshot: prepareCorrectionSnapshot(
                value.document,
                value.replay,
                input.storedFindings,
              ),
            }),
      };
    }
    case "player_heights":
      return readImmutableSourceBundle(input.root, input.season, input.gameId, input.hash).then(
        (bundle) => ({
          kind: "player_heights",
          value: extractNaverPlayerHeights(bundle),
        }),
      );
    case "source_bundle":
      return readImmutableSourceBundle(input.root, input.season, input.gameId, input.hash).then(
        (bundle) => ({
          kind: "source_bundle",
          value: { bundle, bytes: Buffer.byteLength(JSON.stringify(bundle), "utf8") },
        }),
      );
    case "projection":
      return {
        kind: input.kind,
        value: buildRelationalProjection(
          input.document,
          input.replay,
          input.revision,
          input.version,
        ),
      };
    case "projection_hash":
      return { kind: input.kind, value: hashProjectionTables(input.tables, input.version) };
    case "proposal":
      return {
        kind: input.kind,
        value: buildRecordCorrectionBatchProposal(input.document, input.notice, input.binding),
      };
    case "source":
      return {
        kind: input.kind,
        value: projectNaverSourceBundle(input.bundle, input.base, input.findings),
      };
    case "pitch_reference":
      return {
        kind: input.kind,
        value: preparePitchAnalysisReference(input.rows, input.calibration ?? null),
      };
    case "pitch_calibration":
      return {
        kind: input.kind,
        value: calculatePitchCalibration(
          input.season,
          input.sourceHash,
          input.rows,
          input.previous,
        ),
      };
    case "pitch_sample":
      return {
        kind: input.kind,
        value: calculatePitchAnalysisSample(
          input.season,
          input.pitcherId,
          input.sourceHash,
          input.rows,
          input.reference,
          input.calibration,
        ),
      };
  }
}
