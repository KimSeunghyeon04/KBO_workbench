import { readFile } from "node:fs/promises";

import {
  parseStoredFindingEnvelopeV2,
  type StoredFinding,
  type StoredFindingEnvelopeV2,
} from "@kbo/contracts";

import { isMissing } from "./workspace-files.js";

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
