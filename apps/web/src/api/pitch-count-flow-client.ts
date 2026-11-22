import {
  BatterCountFlowResponseSchema,
  canonicalStringify,
  PitchCountFlowResponseSchema,
  pitchCountTerminalOutcomes,
  pitchOutcomeScope,
  type BatterCountFlowGroup,
  type BatterCountFlowQuery,
  type BatterCountFlowResponse,
  type PitchCountFlowGroup,
  type PitchCountFlowQuery,
  type PitchCountFlowResponse,
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

function encodeQuery(query: PitchCountFlowQuery) {
  return new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
}

export async function getPitchCountFlow(
  query: PitchCountFlowQuery,
  id: string,
  signal: AbortSignal,
) {
  const result = Value.Decode(
    PitchCountFlowResponseSchema,
    await requestJson(
      `/api/v2/analysis/pitch-location/${encodeURIComponent(id)}/count-flow?${encodeQuery(query)}`,
      { signal },
    ),
  );
  // Earlier servers strip unknown query fields and return the original summary.
  const { include, ...baseQuery } = query;
  const expectedQuery =
    include !== undefined && result.query.include === undefined ? baseQuery : query;
  if (result.pitcherId !== id || !validCountFlow(result, expectedQuery))
    throw new Error("카운트 전이의 조회 범위 또는 표본 합계가 다릅니다.");
  return result;
}

export async function getBatterCountFlow(
  query: BatterCountFlowQuery,
  id: string,
  signal: AbortSignal,
) {
  const result = Value.Decode(
    BatterCountFlowResponseSchema,
    await requestJson(
      `/api/v2/analysis/batter-profile/${encodeURIComponent(id)}/count-flow?${encodeQuery(query)}`,
      { signal },
    ),
  );
  const { split, ...baseQuery } = query;
  const expectedQuery = split !== undefined && result.query.split === undefined ? baseQuery : query;
  const sides = result.byPitcherHand;
  const selectedPitches = result.scopePitches - result.excludedSituations;
  const left = sides?.left.map((group) => ({ ...group, stance: "L" as const })) ?? [];
  const right = sides?.right.map((group) => ({ ...group, stance: "R" as const })) ?? [];
  if (
    result.batterId !== id ||
    !validCountFlow(result, expectedQuery) ||
    (sides !== undefined) !== (result.query.split === "pitcher-hand") ||
    (sides !== undefined &&
      ([...left, ...right].reduce((total, group) => total + group.pitches, sides.unknownPitches) !==
        selectedPitches ||
        !validGroups(
          [...result.groups, ...left, ...right],
          selectedPitches,
          query.include === "terminal-details",
        ) ||
        !validSplitSwings(result.groups, [...left, ...right]))) ||
    ![...result.groups, ...(sides?.left ?? []), ...(sides?.right ?? [])].every(
      (group) =>
        [group, ...group.types].every(validSwingRate) &&
        group.types.reduce((total, type) => total + type.swings, 0) === group.swings,
    )
  )
    throw new Error("카운트별 대응의 조회 범위 또는 표본 합계가 다릅니다.");
  return result;
}

function validSplitSwings(
  pooled: readonly BatterCountFlowGroup[],
  split: readonly Omit<BatterCountFlowGroup, "stance">[],
) {
  return pooled.every((group) => {
    const sides = split.filter(
      (side) => side.balls === group.balls && side.strikes === group.strikes,
    );
    return (
      sides.reduce((total, side) => total + side.swings, 0) <= group.swings &&
      group.types.every(
        (type) =>
          sides
            .flatMap((side) => side.types)
            .reduce(
              (total, side) => total + (side.pitchType === type.pitchType ? side.swings : 0),
              0,
            ) <= type.swings,
      )
    );
  });
}

function validSwingRate({
  pitches,
  swings,
  swingRate,
}: Pick<BatterCountFlowGroup, "pitches" | "swings" | "swingRate">) {
  return swings <= pitches && swingRate === swings / pitches;
}

function validCountFlow(
  result: PitchCountFlowResponse | BatterCountFlowResponse,
  query: PitchCountFlowQuery,
) {
  return (
    canonicalStringify(result.query) === canonicalStringify(query) &&
    canonicalStringify(result.scope) === canonicalStringify(pitchOutcomeScope(query)) &&
    (query.cohort === "discipline" || result.excludedSituations === 0) &&
    validGroups(
      result.groups,
      result.scopePitches - result.excludedSituations,
      query.include === "terminal-details",
    )
  );
}
