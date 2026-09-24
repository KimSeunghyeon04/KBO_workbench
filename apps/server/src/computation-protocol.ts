import type { RawGameBundle, SourceFinding } from "@kbo/collection";
import type { RunModelComputation, RunModel } from "./run-model-computation.js";
import type {
  CorrectionCommand,
  GamePlayerHeightDataset,
  StagingGameDocumentV2,
  RecordCorrectionNotice,
  RecordCorrectionMatchCandidate,
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
import type {
  CorrectionResult,
  BuiltRecordCorrectionProposal,
  RecordCorrectionProposalBinding,
} from "@kbo/correction";
import type { ReplayResult } from "@kbo/game-core";
import type {
  PitchAnalysisRow,
  CurrentRevisionBase,
  RecordCorrectionGameCandidate,
  ImmutableSourceBundle,
  RelationalProjection,
  ProjectionTables,
  ProjectionVersion,
} from "@kbo/persistence";
import type { PreparedCorrectionSnapshot } from "./correction-snapshot.js";
import type { SourceEvidenceComputationInput } from "./source-evidence-computation.js";
import type { SourceProjection } from "./source-projection.js";

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
  | {
      kind: "record_correction_match";
      document: StagingGameDocumentV2;
      notice: RecordCorrectionNotice;
      game: RecordCorrectionGameCandidate;
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
  | { kind: "record_correction_match"; value: RecordCorrectionMatchCandidate[] }
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

export interface ComputationRunner {
  run(input: Computation, signal?: AbortSignal): Promise<ComputationResult>;
}
