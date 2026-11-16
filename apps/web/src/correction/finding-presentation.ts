import {
  compareCanonicalStrings,
  type CorrectionFinding,
  type CorrectionSession,
  type StagingGameDocumentV2,
} from "@kbo/contracts";

export type FindingOrigin = "stored" | "current" | "both";

export interface DisplayFinding extends CorrectionFinding {
  readonly origin: FindingOrigin;
}

export function findingCategoryLabel(category: CorrectionFinding["category"]): string {
  if (category === "source") return "원문·수집";
  if (category === "domain") return "경기 규칙·기록";
  return "저장·무결성";
}

export function findingMessageLabel(message: string): string {
  return message
    .replaceAll("compiler 계산", "원장 계산")
    .replaceAll("compiler", "원장 계산기")
    .replaceAll(/\btracking\b/g, "트래킹 관측");
}

type FindingSession = Pick<CorrectionSession, "storedFindings" | "findings">;

export function buildDisplayFindings(
  session: FindingSession | null,
  includeStoredHistory: boolean,
): DisplayFinding[] {
  if (session === null) return [];

  const storedCorrelationKeys = new Set(session.storedFindings.map(findingCorrelationIdentity));
  const currentCorrelationKeys = new Set(session.findings.map(findingCorrelationIdentity));
  const displayed = new Map<string, DisplayFinding>();

  for (const finding of session.findings) {
    displayed.set(findingIdentity(finding), {
      ...finding,
      origin: storedCorrelationKeys.has(findingCorrelationIdentity(finding)) ? "both" : "current",
    });
  }

  if (includeStoredHistory) {
    for (const finding of session.storedFindings) {
      if (currentCorrelationKeys.has(findingCorrelationIdentity(finding))) continue;
      displayed.set(findingIdentity(finding), { ...finding, origin: "stored" });
    }
  }

  return [...displayed.values()].sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      (left.eventSequence ?? Number.MAX_SAFE_INTEGER) -
        (right.eventSequence ?? Number.MAX_SAFE_INTEGER) ||
      compareCanonicalStrings(left.code, right.code),
  );
}

export function findingIdentity(finding: CorrectionFinding): string {
  return [
    finding.code,
    finding.eventId ?? "game",
    finding.recordIdentity ?? "record",
    finding.message,
    JSON.stringify(finding.details),
  ].join(":");
}

export function groupDisplayFindings(
  findings: readonly DisplayFinding[],
  document: StagingGameDocumentV2,
): {
  readonly key: string;
  readonly label: string;
  readonly findings: readonly DisplayFinding[];
}[] {
  const events = new Map(document.events.map((event) => [event.identity.eventId, event]));
  const groups = new Map<string, { key: string; label: string; findings: DisplayFinding[] }>();
  for (const finding of findings) {
    const event = finding.eventId === undefined ? undefined : events.get(finding.eventId);
    const location =
      event === undefined ? "경기 전체" : `${event.inning}회${event.half === "top" ? "초" : "말"}`;
    const key = `${finding.origin}:${finding.severity}:${finding.category}:${location}:${finding.code}`;
    const group = groups.get(key) ?? {
      key,
      label: `${location} · ${findingMessageLabel(finding.message)}`,
      findings: [],
    };
    group.findings.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function findingCorrelationIdentity(finding: CorrectionFinding): string {
  return [
    finding.code,
    finding.category,
    finding.eventId ?? "game",
    finding.recordIdentity ?? "record",
    finding.message,
  ].join(":");
}

function severityRank(severity: CorrectionFinding["severity"]): number {
  return severity === "blocking" ? 0 : 1;
}
