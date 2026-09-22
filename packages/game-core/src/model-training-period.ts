import type { AnalysisModelKind, AnalysisModelPeriod } from "@kbo/contracts";
import { winInningLimit } from "./win-probability-rules.js";

/** Two rolling validation seasons, each preceded by at least one training season. */
export function modelValidationSeasons(through: number, firstTrainingSeason = 2020): number[] {
  return [through - 1, through].filter((season) => season > firstTrainingSeason);
}

export function modelTrainingPeriod(
  kind: AnalysisModelKind,
  applicationSeason: number,
): AnalysisModelPeriod {
  if (!Number.isInteger(applicationSeason) || applicationSeason < 2020 || applicationSeason > 2025)
    throw new Error("Model application season must be 2020–2025");
  const trainedThrough = applicationSeason - 1,
    trainingStartSeason = kind === "win" ? 2022 : 2020,
    validationSeasons = modelValidationSeasons(trainedThrough, trainingStartSeason);
  return {
    applicationSeason,
    trainedThrough,
    trainingStartSeason,
    validationSeasons,
    support:
      kind === "win" && winInningLimit(applicationSeason) === null
        ? "unsupported_rules"
        : validationSeasons.length < 2
          ? "insufficient_history"
          : "eligible",
  };
}

/** Validate a stored artifact's temporal evidence without changing its content hash. */
export function validModelEvaluationSeasons(
  through: number,
  evaluations: readonly { season: number }[],
  firstTrainingSeason = 2020,
): boolean {
  const expected = modelValidationSeasons(through, firstTrainingSeason);
  return (
    evaluations.length === expected.length &&
    evaluations.every((evaluation, index) => evaluation.season === expected[index])
  );
}
