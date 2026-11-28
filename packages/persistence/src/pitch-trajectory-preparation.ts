import {
  inAnalysisPeriod,
  PITCH_ANALYSIS_MODEL_VERSION,
  PITCH_CALIBRATION_PARAMETERS,
  PITCH_REFERENCE_VERSION,
  type AnalysisScope,
  type PitchCalibrationSeason,
} from "@kbo/contracts";
import type { AnalysisReadSnapshot } from "./analysis-snapshot.js";
import type { PitchAnalysisComputation } from "./pitch-analysis-repository.js";
import type { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import { pitchCalibrationHash } from "./pitch-calibration.js";
import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import {
  readPitchRows,
  readSeasonPitchReleaseRows,
  type PitchAnalysisRow,
} from "./pitch-trajectory-input.js";

interface Options {
  readonly referenceScope: AnalysisScope;
  readonly referenceHash: string;
  readonly pitcherId: string;
  readonly scopes: readonly AnalysisScope[];
  readonly targetFinalOnly?: boolean;
  readonly includeSeasonReleaseRows?: boolean;
  readonly computation: PitchAnalysisComputation;
  readonly calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate"> | undefined;
  readonly references?: Pick<PitchReferenceWorkspace, "getOrCreate"> | undefined;
}

export async function preparePitchInputs(
  { client, release }: AnalysisReadSnapshot,
  {
    referenceScope,
    referenceHash,
    pitcherId,
    scopes,
    targetFinalOnly = false,
    includeSeasonReleaseRows = false,
    computation,
    calibrations,
    references,
  }: Options,
) {
  const { season } = referenceScope;
  const targetRows = new Map<AnalysisScope, PitchAnalysisRow[]>();
  let referenceRows: PitchAnalysisRow[] | undefined;
  let releaseRows: PitchAnalysisRow[] | undefined;
  const readTargets = async () => {
    for (const scope of scopes) {
      if (!targetRows.has(scope))
        targetRows.set(
          scope,
          await readPitchRows(client, season, pitcherId, false, scope, targetFinalOnly),
        );
    }
    if (includeSeasonReleaseRows)
      releaseRows ??= await readSeasonPitchReleaseRows(client, referenceScope, pitcherId);
    await release();
  };
  const captureReference = async () => {
    referenceRows ??= await readPitchRows(client, season, null, false, referenceScope, true);
    await readTargets();
    return referenceRows;
  };
  const calculateCalibration = async (previous: PitchCalibrationSeason | null) => {
    const seasonRows = await readPitchRows(
      client,
      season,
      null,
      true,
      referenceScope,
      targetFinalOnly,
    );
    for (const scope of scopes)
      targetRows.set(
        scope,
        seasonRows.filter(
          (row) => row.pitcherId === pitcherId && inAnalysisPeriod(row.gameDate, scope),
        ),
      );
    if (includeSeasonReleaseRows)
      releaseRows = seasonRows.filter((row) => row.gameFinal && row.pitcherId === pitcherId);
    referenceRows = seasonRows.filter((row) => row.gameFinal && row.pitchType === "직구");
    await release();
    return computation.calibration(season, referenceHash, seasonRows, previous);
  };
  const calibration =
    calibrations === undefined
      ? await calculateCalibration(null)
      : await calibrations.getOrCreate(
          {
            modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
            season,
            sourceHash: referenceHash,
          },
          calculateCalibration,
          async () => {
            await captureReference();
          },
        );
  const calculateReference = async () =>
    computation.reference(await captureReference(), calibration);
  const reference =
    references === undefined
      ? await calculateReference()
      : await references.getOrCreate(
          {
            modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
            referenceVersion: PITCH_REFERENCE_VERSION,
            season,
            sourceHash: referenceHash,
            calibrationHash: pitchCalibrationHash(calibration),
          },
          calculateReference,
          readTargets,
        );
  await readTargets();
  const rowsFor = (scope: AnalysisScope) => {
    const rows = targetRows.get(scope);
    if (rows === undefined) throw new Error("Missing pitch analysis target rows");
    return rows;
  };
  return { calibration, reference, releaseRows, rowsFor };
}
