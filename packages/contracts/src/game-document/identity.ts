import { type Static, Type } from "@sinclair/typebox";

import { IdentifierSchema, strict, UuidV7Schema } from "./primitives.js";

export const SourceEventIdentitySchema = Type.Object(
  {
    kind: Type.Literal("source"),
    eventId: IdentifierSchema,
    endpoint: Type.String({ minLength: 1, maxLength: 100 }),
    blockIndex: Type.Integer({ minimum: 0 }),
    eventIndex: Type.Integer({ minimum: 0 }),
    sourceEventId: Type.Optional(IdentifierSchema),
  },
  strict,
);
export const ManualEventIdentitySchema = Type.Object(
  { kind: Type.Literal("manual"), eventId: UuidV7Schema },
  strict,
);
export const EventIdentitySchema = Type.Union([
  SourceEventIdentitySchema,
  ManualEventIdentitySchema,
]);
export type EventIdentity = Static<typeof EventIdentitySchema>;
