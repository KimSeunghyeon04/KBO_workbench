import type { StagingRelayEvent } from "@kbo/contracts";

import type { Finding, FindingDetail } from "../types.js";
import type { CompileContext } from "./model.js";

export function addFinding(
  context: CompileContext,
  event: StagingRelayEvent,
  code: string,
  category: "source" | "domain",
  message: string,
  details: readonly FindingDetail[] = [],
): void {
  context.findings.push(findingFor(context, event, code, category, message, details));
}

export function findingFor(
  context: CompileContext,
  event: StagingRelayEvent,
  code: string,
  category: "source" | "domain",
  message: string,
  details: readonly FindingDetail[] = [],
): Finding {
  return {
    code,
    category,
    severity: "blocking",
    message,
    gameId: context.document.metadata.gameId,
    eventId: event.identity.eventId,
    eventSequence: event.sequence,
    details,
  };
}

export function compareFindings(left: Finding, right: Finding): number {
  return (
    (left.eventSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.eventSequence ?? Number.MAX_SAFE_INTEGER) || left.code.localeCompare(right.code)
  );
}
