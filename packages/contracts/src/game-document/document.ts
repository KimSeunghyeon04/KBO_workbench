import { type Static, Type } from "@sinclair/typebox";

import { StagingRelayEventSchema } from "./events.js";
import { IdentifierSchema, IsoDateSchema, strict, ZonedDateTimeSchema } from "./primitives.js";
import {
  OfficialBatterRecordSchema,
  OfficialPitcherRecordSchema,
  TeamRosterSchema,
  TeamSchema,
  TrackingCandidateSchema,
} from "./records.js";

const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const RevisionBaseSchema = Type.Union([
  Type.Object({ kind: Type.Literal("new_game") }, strict),
  Type.Object(
    {
      kind: Type.Literal("sealed_revision"),
      revision: Type.Integer({ minimum: 1 }),
      documentHash: HashSchema,
    },
    strict,
  ),
]);

export const StagingGameDocumentV2Schema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    source: Type.Object(
      {
        provider: Type.Literal("naver"),
        sourceGameId: IdentifierSchema,
        collectedAt: ZonedDateTimeSchema,
        sourceBundleHash: HashSchema,
      },
      strict,
    ),
    revisionBase: RevisionBaseSchema,
    metadata: Type.Object(
      {
        gameId: IdentifierSchema,
        season: Type.Integer({ minimum: 1982, maximum: 9999 }),
        gameDate: IsoDateSchema,
        scheduledAt: Type.Optional(ZonedDateTimeSchema),
        status: Type.Union([
          Type.Literal("scheduled"),
          Type.Literal("in_progress"),
          Type.Literal("final"),
          Type.Literal("suspended"),
          Type.Literal("cancelled"),
        ]),
        stadium: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        scheduledInnings: Type.Integer({ minimum: 1, maximum: 99 }),
      },
      strict,
    ),
    teams: Type.Object({ away: TeamSchema, home: TeamSchema }, strict),
    rosters: Type.Object({ away: TeamRosterSchema, home: TeamRosterSchema }, strict),
    events: Type.Array(StagingRelayEventSchema),
    trackingCandidates: Type.Array(TrackingCandidateSchema),
    officialRecords: Type.Object(
      {
        batters: Type.Array(OfficialBatterRecordSchema),
        pitchers: Type.Array(OfficialPitcherRecordSchema),
      },
      strict,
    ),
  },
  {
    ...strict,
    $id: "https://kbo-workbench.local/schemas/staging-game-document-v2.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "KBO Workbench StagingGameDocumentV2",
  },
);
export type StagingGameDocumentV2 = Static<typeof StagingGameDocumentV2Schema>;
