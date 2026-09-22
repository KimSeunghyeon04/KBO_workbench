import type { RawGameBundle, SourceFinding } from "@kbo/collection";
import type { RunModelComputation, RunModel } from "./run-model-computation.js";
const { computeRunModel }: typeof import("./run-model-computation.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./run-model-computation.ts" : "./run-model-computation.js",
    import.meta.url,
  ).href
);
import { extractNaverPlayerHeights } from "@kbo/collection";
import type {
  CorrectionCommand,
  GamePlayerHeightDataset,
  StagingGameDocumentV2,
  RecordCorrectionNotice,
  PitchAnalysisSample,
  PitchReference,
  PitchCalibrationSeason,
  StoredFinding,
  CorrectionSourceEvidence,
  ParkEnvironmentRow,
  ParkEnvironmentModel,
  PitchQualityRow,
  PitchQualityModel,
  PitchQualityResponse,
  AnalysisScope,
  MatchupModel,
  MatchupModelResponse,
  MatchupQuery,
  PitchAnglesResponse,
  AnalysisScopeQuery,
  WorkloadAppearance,
  WorkloadComparisonCell,
  WorkloadComparisonResponse,
} from "@kbo/contracts";
import {
  applyCorrectionCommand,
  buildRecordCorrectionBatchProposal,
  type CorrectionResult,
  type BuiltRecordCorrectionProposal,
  type RecordCorrectionProposalBinding,
} from "@kbo/correction";
import {
  compileStagingGameDocumentV2,
  summarizePitchQuality,
  summarizeMatchupModel,
  analyzePitchAngles,
  comparePitcherWorkload,
  trainParkEnvironment,
  type ReplayResult,
} from "@kbo/game-core";
import {
  trainPitchQualityFromFacts,
  preparePitchAnalysisReference,
  calculatePitchAnalysisSample,
  calculatePitchCalibration,
  type PitchAnalysisRow,
  type CurrentRevisionBase,
  readImmutableSourceBundle,
  buildRelationalProjection,
  hashProjectionTables,
  type ImmutableSourceBundle,
  type RelationalProjection,
  type ProjectionTables,
  type ProjectionVersion,
  type RevisionProjectionComputation,
} from "@kbo/persistence";
import type { PreparedCorrectionSnapshot } from "./correction-snapshot.js";
import type { SourceEvidenceComputationInput } from "./source-evidence-computation.js";
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
import type { SourceProjection } from "./source-projection.js";
const { projectNaverSourceBundle }: typeof import("./source-projection.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./source-projection.ts" : "./source-projection.js",
    import.meta.url,
  ).href
);

// Internal messages connect this executable's own modules. External documents and commands
// are strictly decoded by the same public compiler/command entry points in either executor.
export type Computation =
  | {
      kind: "workload_comparison";
      query: AnalysisScopeQuery;
      scope: AnalysisScope;
      pitcherId: string;
      sourceHash: string;
      history: readonly WorkloadAppearance[];
      cells: readonly WorkloadComparisonCell[];
    }
  | {
      kind: "pitch_angles";
      rows: readonly PitchAnalysisRow[];
      scope: AnalysisScope;
      pitcherId: string;
      sourceHash: string;
    }
  | {
      kind: "matchup_summary";
      query: MatchupQuery;
      scope: AnalysisScope;
      sourceHash: string;
      pitcherRows: readonly PitchQualityRow[];
      batterRows: readonly PitchQualityRow[];
      model: MatchupModel | null;
      modelHash: string | null;
    }
  | {
      kind: "pitch_quality_model";
      rows: readonly PitchQualityRow[];
      through: number;
      sourceHash: string;
    }
  | {
      kind: "pitch_quality_summary";
      rows: readonly PitchQualityRow[];
      scope: AnalysisScope;
      pitcherId: string;
      sourceHash: string;
      model: PitchQualityModel | null;
      modelHash: string | null;
    }
  | { kind: "park_model"; rows: readonly ParkEnvironmentRow[]; through: number; sourceHash: string }
  | RunModelComputation
  | { kind: "warmup" }
  | ({ kind: "source_evidence" } & SourceEvidenceComputationInput)
  | { kind: "compile"; document: StagingGameDocumentV2; storedFindings?: readonly StoredFinding[] }
  | {
      kind: "command";
      document: StagingGameDocumentV2;
      command: CorrectionCommand;
      storedFindings?: readonly StoredFinding[];
    }
  | { kind: "source_bundle"; root: string; season: number; gameId: string; hash: string }
  | { kind: "player_heights"; root: string; season: number; gameId: string; hash: string }
  | {
      kind: "projection";
      document: StagingGameDocumentV2;
      replay: ReplayResult;
      revision: number;
      version: ProjectionVersion;
    }
  | { kind: "projection_hash"; tables: ProjectionTables; version: ProjectionVersion }
  | {
      kind: "proposal";
      document: StagingGameDocumentV2;
      notice: RecordCorrectionNotice;
      binding: RecordCorrectionProposalBinding;
    }
  | {
      kind: "source";
      bundle: RawGameBundle;
      base: CurrentRevisionBase | null;
      findings: readonly SourceFinding[];
    }
  | {
      kind: "pitch_calibration";
      season: number;
      sourceHash: string;
      rows: readonly PitchAnalysisRow[];
      previous: PitchCalibrationSeason | null;
    }
  | {
      kind: "pitch_reference";
      rows: readonly PitchAnalysisRow[];
      calibration?: PitchCalibrationSeason;
    }
  | {
      kind: "pitch_sample";
      season: number;
      pitcherId: string;
      sourceHash: string;
      rows: readonly PitchAnalysisRow[];
      reference: PitchReference["reference"];
      calibration: PitchCalibrationSeason;
    };
export type ComputationResult =
  | { kind: "workload_comparison"; value: WorkloadComparisonResponse }
  | { kind: "pitch_angles"; value: PitchAnglesResponse }
  | { kind: "matchup_summary"; value: MatchupModelResponse }
  | { kind: "pitch_quality_model"; value: PitchQualityModel }
  | { kind: "pitch_quality_summary"; value: PitchQualityResponse }
  | { kind: "park_model"; value: ParkEnvironmentModel }
  | { kind: "run_model"; value: RunModel }
  | { kind: "warmup"; value: null }
  | { kind: "source_evidence"; value: CorrectionSourceEvidence }
  | { kind: "compile"; value: ReplayResult; snapshot?: PreparedCorrectionSnapshot }
  | { kind: "command"; value: CorrectionResult; snapshot?: PreparedCorrectionSnapshot }
  | { kind: "source_bundle"; value: { bundle: ImmutableSourceBundle; bytes: number } }
  | { kind: "player_heights"; value: GamePlayerHeightDataset }
  | { kind: "projection"; value: RelationalProjection }
  | { kind: "projection_hash"; value: string }
  | { kind: "proposal"; value: BuiltRecordCorrectionProposal }
  | { kind: "source"; value: SourceProjection }
  | { kind: "pitch_reference"; value: PitchReference["reference"] }
  | { kind: "pitch_calibration"; value: PitchCalibrationSeason }
  | { kind: "pitch_sample"; value: PitchAnalysisSample };
export type ComputationReply =
  | { id: number; ok: true; result: ComputationResult }
  | {
      id: number;
      ok: false;
      error: string;
      errorKind: "command" | "source" | "evidence" | "internal";
    };
export interface ComputationRequest {
  id: number;
  input: Computation;
  append: boolean;
  complete: boolean;
}

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

export interface ComputationRunner {
  run(input: Computation, signal?: AbortSignal): Promise<ComputationResult>;
}
export const inlineComputation: ComputationRunner = { run: async (input) => compute(input) };

export async function compileDocument(
  runner: ComputationRunner,
  document: StagingGameDocumentV2,
): Promise<ReplayResult> {
  const result = await runner.run({ kind: "compile", document });
  if (result.kind !== "compile") throw new Error("Unexpected compiler result");
  return result.value;
}

export async function compileCorrectionDocument(
  runner: ComputationRunner,
  document: StagingGameDocumentV2,
  storedFindings: readonly StoredFinding[],
): Promise<{ replay: ReplayResult; prepared: PreparedCorrectionSnapshot }> {
  const result = await runner.run({ kind: "compile", document, storedFindings });
  if (result.kind !== "compile" || result.snapshot === undefined)
    throw new Error("Missing correction snapshot");
  return { replay: result.value, prepared: result.snapshot };
}

export function createRevisionProjectionComputation(
  runner: ComputationRunner,
): RevisionProjectionComputation {
  return {
    async project(document, replay, revision, version) {
      const result = await runner.run({ kind: "projection", document, replay, revision, version });
      if (result.kind !== "projection") throw new Error("Unexpected projection result");
      return result.value;
    },
    async hash(tables, version) {
      const result = await runner.run({ kind: "projection_hash", tables, version });
      if (result.kind !== "projection_hash") throw new Error("Unexpected projection hash result");
      return result.value;
    },
  };
}
