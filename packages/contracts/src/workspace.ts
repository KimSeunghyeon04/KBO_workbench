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
const CurrentAuthoritySchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("quarantine"),
  Type.Literal("source_failure"),
]);
const FindingValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const WorkspaceDisplaySummarySchema = Type.Object(
  {
    gameDate: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    teams: Type.Object(
      {
        away: Type.Object(
          { teamId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) },
          strict,
        ),
        home: Type.Object(
          { teamId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) },
          strict,
        ),
      },
      strict,
    ),
  },
  strict,
);

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
    producer: Type.Union([
      Type.Literal("collection"),
      Type.Literal("compiler"),
      Type.Literal("correction"),
      Type.Literal("migration"),
    ]),
    lifecycle: Type.Union([
      Type.Literal("persistent"),
      Type.Literal("while_event_unresolved"),
      Type.Literal("recomputed"),
    ]),
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

export const StoredFindingEnvelopeV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    findings: StoredFindingsSchema,
  },
  strict,
);

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
    season: Type.Union([Type.Integer({ minimum: 1982, maximum: 9999 }), Type.Null()]),
    recordedAt: DateTimeSchema,
    findingEnvelope: StoredFindingEnvelopeV2Schema,
  },
  strict,
);

export const ImmutableArtifactMetadataSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    pageKind: Type.String({ minLength: 1, maxLength: 100 }),
    requestKey: Type.String({ minLength: 1, maxLength: 500 }),
    artifactKey: Type.String({
      pattern: "^[A-Za-z0-9._/-]+$",
      minLength: 1,
      maxLength: 1000,
    }),
    contentHash: HashSchema,
    collectedAt: DateTimeSchema,
  },
  strict,
);

const CurrentWorkspaceEntryCommonFields = {
  gameId: GameIdSchema,
  generation: Type.Integer({ minimum: 1 }),
  updatedAt: DateTimeSchema,
  artifactPath: Type.String({
    pattern: "^active/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$",
    minLength: 1,
    maxLength: 500,
  }),
  contentHash: HashSchema,
} as const;

export const LegacyCurrentWorkspaceEntryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    ...CurrentWorkspaceEntryCommonFields,
    season: Type.Union([Type.Integer({ minimum: 1982, maximum: 9999 }), Type.Null()]),
    authority: CurrentAuthoritySchema,
    documentHash: Type.Union([HashSchema, Type.Null()]),
  },
  strict,
);

export const CurrentWorkspaceDocumentEntryV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    ...CurrentWorkspaceEntryCommonFields,
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    authority: Type.Union([Type.Literal("ready"), Type.Literal("quarantine")]),
    documentHash: HashSchema,
    displaySummary: WorkspaceDisplaySummarySchema,
  },
  strict,
);

export const CurrentWorkspaceSourceFailureEntryV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    ...CurrentWorkspaceEntryCommonFields,
    season: Type.Union([Type.Integer({ minimum: 1982, maximum: 9999 }), Type.Null()]),
    authority: Type.Literal("source_failure"),
    documentHash: Type.Null(),
    displaySummary: Type.Null(),
  },
  strict,
);

export const CurrentWorkspaceEntrySchema = Type.Union([
  CurrentWorkspaceDocumentEntryV2Schema,
  CurrentWorkspaceSourceFailureEntryV2Schema,
]);

export const WorkspaceTransitionJournalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    transitionId: Type.String({ minLength: 1, maxLength: 200 }),
    gameId: GameIdSchema,
    previous: Type.Union([CurrentWorkspaceEntrySchema, Type.Null()]),
    target: Type.Union([CurrentWorkspaceEntrySchema, Type.Null()]),
    createdAt: DateTimeSchema,
  },
  strict,
);

export const WorkspaceManifestUpgradeJournalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    kind: Type.Literal("manifest_upgrade"),
    transitionId: Type.String({ minLength: 1, maxLength: 200 }),
    gameId: GameIdSchema,
    previous: LegacyCurrentWorkspaceEntryV1Schema,
    target: CurrentWorkspaceEntrySchema,
    createdAt: DateTimeSchema,
  },
  strict,
);

export const WriterLockOwnerSchema = Type.Object(
  {
    token: Type.String({ minLength: 1 }),
    pid: Type.Integer({ minimum: 0 }),
    hostname: Type.String({ minLength: 1 }),
    acquiredAt: DateTimeSchema,
    processStartedAt: Type.Optional(DateTimeSchema),
  },
  strict,
);

const CorrectionCommitFields = {
  targetAuthority: AuthoritySchema,
  baseDocumentHash: HashSchema,
  document: StagingGameDocumentV2Schema,
  findingEnvelope: StoredFindingEnvelopeV2Schema,
} as const;

export const StagingCorrectionCommitSchema = Type.Union([
  Type.Object(
    {
      baseAuthority: AuthoritySchema,
      ...CorrectionCommitFields,
    },
    strict,
  ),
  Type.Object(
    {
      baseAuthority: Type.Literal("superseded"),
      baseSnapshotId: Type.String({
        pattern: "^[0-9]+-[0-9a-f]{64}\\.document\\.json$",
        maxLength: 200,
      }),
      baseCurrentContentHash: Type.Union([HashSchema, Type.Null()]),
      ...CorrectionCommitFields,
    },
    strict,
  ),
]);

const CorrectionJournalFields = {
  ...CorrectionCommitFields,
  journalId: Type.Optional(Type.String({ minLength: 1 })),
  beforeDocument: StagingGameDocumentV2Schema,
  createdAt: DateTimeSchema,
} as const;

export const CorrectionJournalSchema = Type.Union([
  Type.Object(
    {
      baseAuthority: AuthoritySchema,
      ...CorrectionJournalFields,
    },
    strict,
  ),
  Type.Object(
    {
      baseAuthority: Type.Literal("superseded"),
      baseSnapshotId: Type.String({
        pattern: "^[0-9]+-[0-9a-f]{64}\\.document\\.json$",
        maxLength: 200,
      }),
      baseCurrentContentHash: Type.Union([HashSchema, Type.Null()]),
      ...CorrectionJournalFields,
    },
    strict,
  ),
]);

export interface StoredFindingDetail {
  readonly field: string;
  readonly expected?: string | number | boolean | null;
  readonly actual?: string | number | boolean | null;
}

export interface StoredFinding {
  readonly producer: "collection" | "compiler" | "correction" | "migration";
  readonly lifecycle: "persistent" | "while_event_unresolved" | "recomputed";
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

export interface StoredFindingEnvelopeV2 {
  readonly schemaVersion: 2;
  readonly findings: readonly StoredFinding[];
}

export type SourceBundleManifest = Static<typeof SourceBundleManifestSchema>;
export type SourceFailureRecord = Static<typeof SourceFailureRecordSchema>;
export type ImmutableArtifactMetadata = Static<typeof ImmutableArtifactMetadataSchema>;
export type WorkspaceDisplaySummary = Static<typeof WorkspaceDisplaySummarySchema>;
export type LegacyCurrentWorkspaceEntryV1 = Static<typeof LegacyCurrentWorkspaceEntryV1Schema>;
export type CurrentWorkspaceEntry = Static<typeof CurrentWorkspaceEntrySchema>;
export type WorkspaceTransitionJournal = Static<typeof WorkspaceTransitionJournalSchema>;
export type WorkspaceManifestUpgradeJournal = Static<typeof WorkspaceManifestUpgradeJournalSchema>;
export interface WriterLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly processStartedAt?: string;
}

interface StagingCorrectionCommitFields {
  readonly targetAuthority: "staging" | "quarantine";
  readonly baseDocumentHash: string;
  readonly document: StagingGameDocumentV2;
  readonly findingEnvelope: StoredFindingEnvelopeV2;
}

export type StagingCorrectionCommit = StagingCorrectionCommitFields &
  (
    | { readonly baseAuthority: "staging" | "quarantine" }
    | {
        readonly baseAuthority: "superseded";
        readonly baseSnapshotId: string;
        readonly baseCurrentContentHash: string | null;
      }
  );

export type CorrectionJournal = StagingCorrectionCommit & {
  readonly journalId?: string;
  readonly beforeDocument: StagingGameDocumentV2;
  readonly createdAt: string;
};

export function parseStoredFindings(value: unknown): StoredFinding[] {
  return Value.Decode(StoredFindingsSchema, value);
}

export function parseStoredFindingEnvelopeV2(value: unknown): StoredFindingEnvelopeV2 {
  return Value.Decode(StoredFindingEnvelopeV2Schema, value);
}

export function parseSourceBundleManifest(value: unknown): SourceBundleManifest {
  return Value.Decode(SourceBundleManifestSchema, value);
}

export function parseSourceFailureRecord(value: unknown): SourceFailureRecord {
  return Value.Decode(SourceFailureRecordSchema, value);
}

export function parseImmutableArtifactMetadata(value: unknown): ImmutableArtifactMetadata {
  return Value.Decode(ImmutableArtifactMetadataSchema, value);
}

export function parseCurrentWorkspaceEntry(value: unknown): CurrentWorkspaceEntry {
  return Value.Decode(CurrentWorkspaceEntrySchema, value);
}

export function parseLegacyCurrentWorkspaceEntryV1(value: unknown): LegacyCurrentWorkspaceEntryV1 {
  return Value.Decode(LegacyCurrentWorkspaceEntryV1Schema, value);
}

export function parseWorkspaceTransitionJournal(value: unknown): WorkspaceTransitionJournal {
  return Value.Decode(WorkspaceTransitionJournalSchema, value);
}

export function parseWorkspaceManifestUpgradeJournal(
  value: unknown,
): WorkspaceManifestUpgradeJournal {
  return Value.Decode(WorkspaceManifestUpgradeJournalSchema, value);
}

export function parseWriterLockOwner(value: unknown): WriterLockOwner {
  return Value.Decode(WriterLockOwnerSchema, value);
}

export function parseCorrectionJournal(value: unknown): CorrectionJournal {
  return Value.Decode(CorrectionJournalSchema, value);
}

export function parseStagingCorrectionCommit(value: unknown): StagingCorrectionCommit {
  return Value.Decode(StagingCorrectionCommitSchema, value);
}
