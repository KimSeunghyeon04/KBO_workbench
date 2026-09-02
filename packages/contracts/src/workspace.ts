import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { StagingGameDocumentV2Schema, type StagingGameDocumentV2 } from "./game-document.js";

const strict = { additionalProperties: false } as const;
const GameIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 });
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const DateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});
const AuthoritySchema = Type.Union([Type.Literal("staging"), Type.Literal("quarantine")]);
const FindingValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const StoredFindingDetailSchema = Type.Object(
  {
    field: Type.String(),
    expected: Type.Optional(FindingValueSchema),
    actual: Type.Optional(FindingValueSchema),
  },
  strict,
);

export const StoredFindingSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    category: Type.Union([
      Type.Literal("source"),
      Type.Literal("domain"),
      Type.Literal("persistence"),
    ]),
    severity: Type.Union([Type.Literal("warning"), Type.Literal("blocking")]),
    message: Type.String(),
    eventId: Type.Optional(Type.String()),
    endpoint: Type.Optional(Type.String()),
    gameId: Type.Optional(GameIdSchema),
    eventSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    recordIdentity: Type.Optional(Type.String()),
    details: Type.Optional(Type.Array(StoredFindingDetailSchema)),
  },
  strict,
);

export const StoredFindingsSchema = Type.Array(StoredFindingSchema);

export const SourceEndpointManifestSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" }),
    hash: HashSchema,
  },
  strict,
);

export const SourceBundleManifestSchema = Type.Object(
  {
    gameId: GameIdSchema,
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    collectedAt: DateTimeSchema,
    sourceBundleHash: HashSchema,
    missingEndpoints: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" }), {
      uniqueItems: true,
    }),
    endpoints: Type.Array(SourceEndpointManifestSchema),
  },
  strict,
);

export const SourceFailureRecordSchema = Type.Object(
  {
    gameId: GameIdSchema,
    recordedAt: DateTimeSchema,
    findings: StoredFindingsSchema,
  },
  strict,
);

export const WriterLockOwnerSchema = Type.Object(
  {
    token: Type.String({ minLength: 1 }),
    pid: Type.Integer({ minimum: 0 }),
    hostname: Type.String({ minLength: 1 }),
    acquiredAt: DateTimeSchema,
  },
  strict,
);

export const StagingCorrectionCommitSchema = Type.Object(
  {
    baseAuthority: AuthoritySchema,
    targetAuthority: AuthoritySchema,
    baseDocumentHash: HashSchema,
    document: StagingGameDocumentV2Schema,
    findings: StoredFindingsSchema,
  },
  strict,
);

export const CorrectionJournalSchema = Type.Object(
  {
    baseAuthority: AuthoritySchema,
    targetAuthority: AuthoritySchema,
    baseDocumentHash: HashSchema,
    document: StagingGameDocumentV2Schema,
    findings: StoredFindingsSchema,
    journalId: Type.Optional(Type.String({ minLength: 1 })),
    beforeDocument: StagingGameDocumentV2Schema,
    createdAt: DateTimeSchema,
  },
  strict,
);

export interface StoredFindingDetail {
  readonly field: string;
  readonly expected?: string | number | boolean | null;
  readonly actual?: string | number | boolean | null;
}

export interface StoredFinding {
  readonly code: string;
  readonly category: "source" | "domain" | "persistence";
  readonly severity: "warning" | "blocking";
  readonly message: string;
  readonly eventId?: string;
  readonly endpoint?: string;
  readonly gameId?: string;
  readonly eventSequence?: number;
  readonly recordIdentity?: string;
  readonly details?: readonly StoredFindingDetail[];
}

export type SourceBundleManifest = Static<typeof SourceBundleManifestSchema>;
export interface SourceFailureRecord {
  readonly gameId: string;
  readonly recordedAt: string;
  readonly findings: readonly StoredFinding[];
}
export interface WriterLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

export interface StagingCorrectionCommit {
  readonly baseAuthority: "staging" | "quarantine";
  readonly targetAuthority: "staging" | "quarantine";
  readonly baseDocumentHash: string;
  readonly document: StagingGameDocumentV2;
  readonly findings: readonly StoredFinding[];
}

export interface CorrectionJournal extends StagingCorrectionCommit {
  readonly journalId?: string;
  readonly beforeDocument: StagingGameDocumentV2;
  readonly createdAt: string;
}

export function parseStoredFindings(value: unknown): StoredFinding[] {
  return Value.Decode(StoredFindingsSchema, value);
}

export function parseSourceBundleManifest(value: unknown): SourceBundleManifest {
  return Value.Decode(SourceBundleManifestSchema, value);
}

export function parseSourceFailureRecord(value: unknown): SourceFailureRecord {
  return Value.Decode(SourceFailureRecordSchema, value);
}

export function parseWriterLockOwner(value: unknown): WriterLockOwner {
  return Value.Decode(WriterLockOwnerSchema, value);
}

export function parseCorrectionJournal(value: unknown): CorrectionJournal {
  return Value.Decode(CorrectionJournalSchema, value);
}
