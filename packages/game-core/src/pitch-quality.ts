import type {
  PitchQualityModel,
  PitchQualityRow,
  PitchQualityResponse,
  AnalysisScope,
} from "@kbo/contracts";
import { prepareQualityRows, qualityCohort } from "./pitch-quality-features.js";
import { prepareQualityPredictors } from "./pitch-quality-target.js";

export function summarizePitchQuality(
  rows: readonly PitchQualityRow[],
  scope: AnalysisScope,
  pitcherId: string,
  sourceHash: string,
  model: PitchQualityModel | null,
  modelHash: string | null,
): PitchQualityResponse {
  const compatible = scope.competition === "regular" && model?.trainedThrough === scope.season - 1,
    usable = compatible ? model : null,
    prepared = prepareQualityRows(rows, usable !== null),
    cohort = usable === null ? null : qualityCohort(prepared, usable.preprocessing),
    samples = cohort?.samples ?? [];
  const predictors =
    usable === null
      ? []
      : prepareQualityPredictors(
          samples,
          usable.preprocessing,
          usable.targets.map((target) => (target.adopted ? target.fitted : null)),
        );
  const groupMap = new Map<
    string | null,
    {
      pitches: number;
      swing: { n: number; y: number; p: number };
      whiff: { n: number; y: number; p: number };
      calledStrike: { n: number; y: number; p: number };
      whiffPerPitch: { n: number; y: number; p: number };
    }
  >();
  for (const row of rows) {
    const g = groupMap.get(row.pitchType) ?? {
      pitches: 0,
      swing: { n: 0, y: 0, p: 0 },
      whiff: { n: 0, y: 0, p: 0 },
      calledStrike: { n: 0, y: 0, p: 0 },
      whiffPerPitch: { n: 0, y: 0, p: 0 },
    };
    g.pitches++;
    groupMap.set(row.pitchType, g);
  }
  const evaluated =
    cohort === null
      ? prepared.filter((r) => r.eligible).map((row) => ({ row, key: "", features: [] }))
      : samples;
  for (let i = 0; i < evaluated.length; i++) {
    const s = evaluated[i];
    if (s === undefined) continue;
    const g = groupMap.get(s.row.pitchType);
    if (g === undefined) continue;
    const ps = predictors[0]?.(s, i) ?? 0,
      pw = predictors[1]?.(s, i) ?? 0,
      pc = predictors[2]?.(s, i) ?? 0;
    g.swing.n++;
    g.swing.y += Number(s.row.swing);
    g.swing.p += ps;
    g.whiffPerPitch.n++;
    g.whiffPerPitch.y += Number(s.row.whiff);
    g.whiffPerPitch.p += ps * pw;
    if (s.row.swing) {
      g.whiff.n++;
      g.whiff.y += Number(s.row.whiff);
      g.whiff.p += pw;
    } else {
      g.calledStrike.n++;
      g.calledStrike.y += Number(s.row.calledStrike);
      g.calledStrike.p += pc;
    }
  }
  const rate = (s: { n: number; y: number; p: number }, adopted: boolean) => ({
    samples: s.n,
    observed: s.n === 0 ? null : s.y / s.n,
    expected: s.n === 0 || !adopted ? null : s.p / s.n,
    difference: s.n === 0 || !adopted ? null : (s.y - s.p) / s.n,
  });
  return {
    version: 1,
    scope,
    pitcherId,
    sourceHash,
    modelHash: usable === null ? null : modelHash,
    trainedThrough: usable?.trainedThrough ?? null,
    status:
      scope.competition !== "regular"
        ? "scope_mismatch"
        : usable === null
          ? "model_unavailable"
          : usable.targets.some((m) => m.adopted)
            ? "ready"
            : "not_adopted",
    coverage: cohort?.coverage ?? {
      actual: rows.length,
      ineligible: rows.filter((r) => !r.eligible).length,
      missing: 0,
      calibrationUnsupported: 0,
      outOfSupport: 0,
      modelUnavailable: rows.filter((r) => r.eligible).length,
      used: 0,
    },
    models:
      usable?.targets.map((m) => ({
        target: m.target,
        adopted: m.adopted,
        kind: m.fitted.kind,
        evaluation: m.evaluation,
      })) ?? [],
    groups: [...groupMap]
      .sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0))
      .map(([pitchType, g]) => ({
        pitchType,
        pitches: g.pitches,
        swing: rate(g.swing, Boolean(predictors[0])),
        whiff: rate(g.whiff, Boolean(predictors[1])),
        calledStrike: rate(g.calledStrike, Boolean(predictors[2])),
        whiffPerPitch: rate(g.whiffPerPitch, Boolean(predictors[0] && predictors[1])),
      })),
  };
}
