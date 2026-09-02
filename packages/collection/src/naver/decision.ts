import { compareCanonicalStrings } from "@kbo/contracts";

import { sourceValueFingerprint } from "./source-values.js";

export interface DecisionEvidence {
  readonly source: "structured" | "source_state" | "exact_text" | "roster" | "context";
  readonly detail: string;
}

export interface DecisionCandidate<Value> {
  readonly value: Value;
  readonly ruleId: string;
  readonly strength: number;
  readonly specificity?: number;
  readonly evidence: readonly DecisionEvidence[];
}

export type ParseDecision<Value> =
  | {
      readonly status: "matched";
      readonly value: Value;
      readonly ruleId: string;
      readonly evidence: readonly DecisionEvidence[];
    }
  | { readonly status: "not_applicable" }
  | {
      readonly status: "unresolved";
      readonly ruleId: string;
      readonly reason: string;
      readonly evidence: readonly DecisionEvidence[];
    };

export function decide<Value>(
  candidates: readonly DecisionCandidate<Value>[],
  unresolvedRuleId: string,
  missingReason: string,
): ParseDecision<Value> {
  if (candidates.length === 0) {
    return { status: "unresolved", ruleId: unresolvedRuleId, reason: missingReason, evidence: [] };
  }
  const ordered = [...candidates].sort(
    (left, right) =>
      right.strength - left.strength ||
      (right.specificity ?? 0) - (left.specificity ?? 0) ||
      compareCanonicalStrings(left.ruleId, right.ruleId),
  );
  const strongest = ordered[0];
  if (strongest === undefined) return { status: "not_applicable" };
  const peers = ordered.filter(
    (candidate) =>
      candidate.strength === strongest.strength &&
      (candidate.specificity ?? 0) === (strongest.specificity ?? 0),
  );
  const values = new Map<string, Value>();
  for (const candidate of peers) values.set(stableDecisionKey(candidate.value), candidate.value);
  const evidence = peers.flatMap((candidate) => candidate.evidence);
  if (values.size > 1) {
    return {
      status: "unresolved",
      ruleId: `${unresolvedRuleId}.conflict`,
      reason: "같은 강도의 근거가 서로 다른 값을 가리킵니다.",
      evidence,
    };
  }
  return {
    status: "matched",
    value: strongest.value,
    ruleId: strongest.ruleId,
    evidence,
  };
}

export function matched<Value>(
  value: Value,
  ruleId: string,
  evidence: readonly DecisionEvidence[],
): ParseDecision<Value> {
  return { status: "matched", value, ruleId, evidence };
}

export function unresolved(
  ruleId: string,
  reason: string,
  evidence: readonly DecisionEvidence[] = [],
): ParseDecision<never> {
  return { status: "unresolved", ruleId, reason, evidence };
}

function stableDecisionKey(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return typeof value === "object"
    ? sourceValueFingerprint(value)
    : `${typeof value}:${String(value)}`;
}
