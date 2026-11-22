import {
  canonicalStringify,
  PitchCountFlowResponseSchema,
  pitchCountTerminalOutcomes,
  pitchOutcomeScope,
  type PitchCountFlowGroup,
  type PitchCountFlowQuery,
  type PitchCountTerminalOutcome,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { ApiClientError, requestJson } from "./transport";

export function isCountFlowUnavailable(error: unknown) {
  return (
    error instanceof ApiClientError &&
    error.status === 404 &&
    error.code === "invalid_error_response"
  );
}

type FlowSummary = Pick<PitchCountFlowGroup, "pitches" | "transitions" | "terminalDetails">;
const terminalOutcomes = [
  ...pitchCountTerminalOutcomes.strikeout,
  ...pitchCountTerminalOutcomes.inPlay,
];

function terminalPitches(sample: FlowSummary, outcome: PitchCountTerminalOutcome) {
  return sample.terminalDetails?.find((detail) => detail.outcome === outcome)?.pitches ?? 0;
}

function sumTerminalPitches(samples: readonly FlowSummary[], outcome: PitchCountTerminalOutcome) {
  return samples.reduce((total, sample) => total + terminalPitches(sample, outcome), 0);
}

function validTerminalDetails(group: FlowSummary, detailed: boolean) {
  const details = group.terminalDetails;
  if (!detailed) return details === undefined;
  if (details === undefined) return false;
  return (
    new Set(details.map((step) => step.outcome)).size === details.length &&
    details.every((step) => step.rate === step.pitches / group.pitches) &&
    Object.entries(pitchCountTerminalOutcomes).every(
      ([parent, outcomes]) =>
        outcomes.reduce((total, outcome) => total + terminalPitches(group, outcome), 0) ===
        group.transitions.find((step) => step.outcome === parent)?.pitches,
    )
  );
}

function validSummary(group: FlowSummary, detailed: boolean) {
  return (
    new Set(group.transitions.map((step) => step.outcome)).size === group.transitions.length &&
    group.transitions.reduce((total, step) => total + step.pitches, 0) === group.pitches &&
    group.transitions.every((step) => step.rate === step.pitches / group.pitches) &&
    validTerminalDetails(group, detailed)
  );
}

function validGroups(groups: readonly PitchCountFlowGroup[], pitches: number, detailed: boolean) {
  const counts = new Map<number, Map<PitchCountFlowGroup["stance"], PitchCountFlowGroup>>();
  let pooledPitches = 0;
  for (const group of groups) {
    const count = group.strikes * 4 + group.balls;
    const sides =
      counts.get(count) ?? new Map<PitchCountFlowGroup["stance"], PitchCountFlowGroup>();
    if (
      sides.has(group.stance) ||
      !validSummary(group, detailed) ||
      new Set(group.types.map((type) => type.pitchType)).size !== group.types.length ||
      group.types.reduce((sum, type) => sum + type.pitches, 0) !== group.pitches ||
      group.types.some(
        (type) => !validSummary(type, detailed) || type.usageRate !== type.pitches / group.pitches,
      ) ||
      (detailed &&
        terminalOutcomes.some(
          (outcome) => sumTerminalPitches(group.types, outcome) !== terminalPitches(group, outcome),
        )) ||
      group.transitions.some(
        (step) =>
          group.types.reduce(
            (sum, type) =>
              sum +
              (type.transitions.find((entry) => entry.outcome === step.outcome)?.pitches ?? 0),
            0,
          ) !== step.pitches,
      )
    )
      return false;
    sides.set(group.stance, group);
    counts.set(count, sides);
    if (group.stance === "all") pooledPitches += group.pitches;
  }
  if (pooledPitches !== pitches) return false;
  for (const sides of counts.values()) {
    const pooled = sides.get("all");
    if (pooled === undefined) return false;
    const splitTypes = [...(sides.get("L")?.types ?? []), ...(sides.get("R")?.types ?? [])];
    if (
      splitTypes.some((type) => !pooled.types.some((entry) => entry.pitchType === type.pitchType))
    ) {
      return false;
    }
    for (const type of pooled.types) {
      const samples = splitTypes.filter((entry) => entry.pitchType === type.pitchType);
      if (
        detailed &&
        terminalOutcomes.some(
          (outcome) => sumTerminalPitches(samples, outcome) > terminalPitches(type, outcome),
        )
      )
        return false;
      for (const step of type.transitions) {
        if (
          samples.reduce(
            (sum, item) =>
              sum +
              (item.transitions.find((entry) => entry.outcome === step.outcome)?.pitches ?? 0),
            0,
          ) > step.pitches
        )
          return false;
      }
    }
  }
  return true;
}

export async function getPitchCountFlow(
  query: PitchCountFlowQuery,
  id: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const result = Value.Decode(
    PitchCountFlowResponseSchema,
    await requestJson(
      `/api/v2/analysis/pitch-location/${encodeURIComponent(id)}/count-flow?${params}`,
      { signal },
    ),
  );
  const { include, ...baseQuery } = query;
  const detailed = result.query.include === "terminal-details";
  // Earlier servers strip unknown query fields and return the original summary.
  const expectedQuery = include !== undefined && !detailed ? baseQuery : query;
  if (
    result.pitcherId !== id ||
    canonicalStringify(result.query) !== canonicalStringify(expectedQuery) ||
    canonicalStringify(result.scope) !== canonicalStringify(pitchOutcomeScope(query)) ||
    (query.cohort !== "discipline" && result.excludedSituations !== 0) ||
    !validGroups(result.groups, result.scopePitches - result.excludedSituations, detailed)
  )
    throw new Error("카운트 전이의 조회 범위 또는 표본 합계가 다릅니다.");
  return result;
}
