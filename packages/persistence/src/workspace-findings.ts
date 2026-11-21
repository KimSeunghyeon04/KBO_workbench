import { readFile } from "node:fs/promises";

import {
  canonicalStringify,
  parseStoredFindingEnvelopeV2,
  type StoredFinding,
  type StoredFindingEnvelopeV2,
} from "@kbo/contracts";
import type { Finding } from "@kbo/game-core";

import { isMissing } from "./workspace-files.js";

export function deduplicateStoredFindings(findings: readonly StoredFinding[]): StoredFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = canonicalStringify(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function storedCompilerFindings(findings: readonly Finding[]): StoredFinding[] {
  return findings.map((finding) => ({
    producer: "compiler",
    lifecycle: "recomputed",
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
    ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
    ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
    ...(finding.details.length === 0
      ? {}
      : { details: finding.details.map((detail) => ({ ...detail })) }),
  }));
}

export async function readFindings(target: string): Promise<readonly StoredFinding[]> {
  return (await readFindingEnvelope(target)).findings;
}

export async function readFindingEnvelope(target: string): Promise<StoredFindingEnvelopeV2> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    return parseStoredFindingEnvelopeV2(value);
  } catch (error: unknown) {
    if (isMissing(error)) return findingEnvelope([]);
    throw error;
  }
}

export function findingEnvelope(findings: readonly StoredFinding[]): StoredFindingEnvelopeV2 {
  return parseStoredFindingEnvelopeV2({ schemaVersion: 2, findings });
}
