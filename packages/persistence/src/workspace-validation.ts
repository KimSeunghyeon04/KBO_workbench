import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import {
  canonicalStringify,
  CurrentWorkspaceEntrySchema,
  ImportTargetSchema,
  parseSourceFailureRecord,
  parseStagingGameDocumentV2,
  parseStoredFindingEnvelopeV2,
  type CurrentWorkspaceEntry,
  type ImportTarget,
  type StagingGameDocumentV2,
  type StoredFinding,
} from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";

export const WorkspaceValidationRequestSchema = Type.Object(
  {
    root: Type.String(),
    current: CurrentWorkspaceEntrySchema,
  },
  { additionalProperties: false },
);
export const WorkspaceValidationSchema = Type.Object(
  {
    blockingFindings: Type.Integer({ minimum: 0 }),
    warningFindings: Type.Integer({ minimum: 0 }),
    target: Type.Union([ImportTargetSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const WorkspaceValidationResponseSchema = Type.Union([
  Type.Object(
    { ok: Type.Literal(true), result: WorkspaceValidationSchema },
    { additionalProperties: false },
  ),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }, { additionalProperties: false }),
]);
export type WorkspaceValidation = Static<typeof WorkspaceValidationSchema>;

export function verifiedImportTarget(
  current: CurrentWorkspaceEntry,
  document: StagingGameDocumentV2,
): ImportTarget {
  if (current.documentHash === null) throw new Error("원장 document hash가 없습니다.");
  return {
    gameId: current.gameId,
    season: document.metadata.season,
    documentHash: current.documentHash,
    revision: document.revisionBase.kind === "new_game" ? 1 : document.revisionBase.revision + 1,
  };
}

export async function readVerifiedDocument(
  root: string,
  current: CurrentWorkspaceEntry,
): Promise<StagingGameDocumentV2> {
  if (current.authority === "source_failure")
    throw new Error(`source failure에는 원장 문서가 없습니다: ${current.gameId}`);
  const document = parseStagingGameDocumentV2(
    JSON.parse(await readFile(artifact(root, current.artifactPath), "utf8")) as unknown,
  );
  const summary = {
    gameDate: document.metadata.gameDate,
    teams: {
      away: { teamId: document.teams.away.teamId, name: document.teams.away.name },
      home: { teamId: document.teams.home.teamId, name: document.teams.home.name },
    },
  };
  if (
    document.metadata.gameId !== current.gameId ||
    document.metadata.season !== current.season ||
    stagingDocumentHash(document) !== current.documentHash ||
    canonicalStringify(summary) !== canonicalStringify(current.displaySummary)
  ) {
    throw new Error(`current 원장 artifact 무결성 검증에 실패했습니다: ${current.gameId}`);
  }
  return document;
}

export async function readVerifiedFindings(
  root: string,
  current: CurrentWorkspaceEntry,
  document: StagingGameDocumentV2,
): Promise<readonly StoredFinding[]> {
  if (current.authority === "source_failure")
    throw new Error(`source failure에는 원장 finding이 없습니다: ${current.gameId}`);
  let envelope;
  try {
    envelope = parseStoredFindingEnvelopeV2(
      JSON.parse(
        await readFile(
          artifact(root, current.artifactPath.replace(/\.document\.json$/, ".findings.json")),
          "utf8",
        ),
      ) as unknown,
    );
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    envelope = parseStoredFindingEnvelopeV2({ schemaVersion: 2, findings: [] });
  }
  if (hash(canonicalStringify({ document, findingEnvelope: envelope })) !== current.contentHash) {
    throw new Error(`current 원장 content hash 검증에 실패했습니다: ${current.gameId}`);
  }
  return envelope.findings;
}

export async function validateWorkspaceEntry(
  root: string,
  current: CurrentWorkspaceEntry,
): Promise<WorkspaceValidation> {
  let findings: readonly StoredFinding[];
  let target: ImportTarget | null = null;
  if (current.authority === "source_failure") {
    const record = parseSourceFailureRecord(
      JSON.parse(await readFile(artifact(root, current.artifactPath), "utf8")) as unknown,
    );
    if (
      record.gameId !== current.gameId ||
      record.season !== current.season ||
      hash(canonicalStringify(record)) !== current.contentHash
    ) {
      throw new Error(
        `current source failure artifact 무결성 검증에 실패했습니다: ${current.gameId}`,
      );
    }
    findings = record.findingEnvelope.findings;
  } else {
    const document = await readVerifiedDocument(root, current);
    findings = await readVerifiedFindings(root, current, document);
    target = verifiedImportTarget(current, document);
  }
  return {
    blockingFindings: findings.filter((finding) => finding.severity === "blocking").length,
    warningFindings: findings.filter((finding) => finding.severity === "warning").length,
    target,
  };
}

function artifact(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("workspace 밖의 artifact 경로입니다.");
  return target;
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
