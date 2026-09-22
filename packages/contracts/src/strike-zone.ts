import { Type, type Static } from "@sinclair/typebox";

export const BatterStrikeZoneSchema = Type.Object(
  {
    ruleYear: Type.Union([Type.Literal(2024), Type.Literal(2025)]),
    batterHeightCm: Type.Integer({ minimum: 100, maximum: 250 }),
    topFeet: Type.Number({ exclusiveMinimum: 0 }),
    bottomFeet: Type.Number({ exclusiveMinimum: 0 }),
    halfWidthFeet: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);
export type BatterStrikeZone = Static<typeof BatterStrikeZoneSchema>;
