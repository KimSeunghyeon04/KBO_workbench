import { Kind, type Static, Type } from "@sinclair/typebox";

export const strict = { additionalProperties: false } as const;
export const IdentifierSchema = Type.String({ minLength: 1, maxLength: 200 });
export const PlayerIdSchema = Type.String({ minLength: 1, maxLength: 100 });
export const RelayTextSchema = Type.String({ minLength: 1, maxLength: 1_000 });
export const IsoDateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
export const ZonedDateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});
export const UuidV7Schema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const SideSchema = Type.Union([Type.Literal("away"), Type.Literal("home")]);
export type Side = Static<typeof SideSchema>;
export const HalfSchema = Type.Union([Type.Literal("top"), Type.Literal("bottom")]);
export type Half = Static<typeof HalfSchema>;

const ObservedBaseSlotSchema = Type.Union([PlayerIdSchema, Type.Boolean(), Type.Null()]);
type ObservedBaseSlot = Static<typeof ObservedBaseSlotSchema>;
type ObservedBases = readonly [ObservedBaseSlot, ObservedBaseSlot, ObservedBaseSlot];
export const ObservedBasesSchema = Type.Unsafe<ObservedBases>({
  [Kind]: "Array",
  type: "array",
  items: ObservedBaseSlotSchema,
  minItems: 3,
  maxItems: 3,
});
export const ObservedStateSchema = Type.Object(
  {
    balls: Type.Optional(Type.Integer({ minimum: 0 })),
    strikes: Type.Optional(Type.Integer({ minimum: 0 })),
    outs: Type.Optional(Type.Integer({ minimum: 0 })),
    bases: Type.Optional(ObservedBasesSchema),
    awayScore: Type.Optional(Type.Integer({ minimum: 0 })),
    homeScore: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
);
export type ObservedState = Static<typeof ObservedStateSchema>;
