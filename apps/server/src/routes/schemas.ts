import { Type } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;

export const JobParamsSchema = Type.Object(
  { jobId: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export const GameParamsSchema = Type.Object(
  {
    gameId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 }),
  },
  strict,
);
export const CorrectionSessionParamsSchema = Type.Object(
  { sessionId: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
export const CorrectionSourceEvidenceParamsSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 200 }),
    eventId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  strict,
);
export const RevisionParamsSchema = Type.Object(
  {
    gameId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 }),
    revision: Type.Integer({ minimum: 1 }),
  },
  strict,
);
export const CorrectionDeleteQuerySchema = Type.Object(
  { expectedSessionVersion: Type.Integer({ minimum: 0 }) },
  strict,
);
export const GamesQuerySchema = Type.Object(
  {
    authority: Type.Optional(
      Type.Union([
        Type.Literal("staging"),
        Type.Literal("quarantine"),
        Type.Literal("source_failure"),
        Type.Literal("database"),
      ]),
    ),
  },
  strict,
);
