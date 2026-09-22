import { Type, type Static } from "@sinclair/typebox";
import {
  PitchLocationResponseSchema,
  PitchRateGroupSchema,
  TerminalPaRowSchema,
} from "./pitch-outcomes.js";
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 }),
  nullable = Type.Union([Type.Number(), Type.Null()]);
export const TerminalBattingGroupSchema = Type.Object(
  {
    key: Type.String(),
    pa: count,
    ab: count,
    hits: count,
    totalBases: count,
    walks: count,
    strikeouts: count,
    hitByPitch: count,
    homeRuns: count,
    avg: nullable,
    slg: nullable,
  },
  strict,
);
export const BatterProfileResponseSchema = Type.Object(
  {
    ...Type.Omit(PitchLocationResponseSchema, ["pitcherId"]).properties,
    batterId: Type.String({ minLength: 1 }),
    bySpeed: Type.Array(PitchRateGroupSchema),
    plateAppearances: Type.Object(
      {
        total: TerminalBattingGroupSchema,
        byTerminalType: Type.Array(TerminalBattingGroupSchema),
        partial: count,
        unattributed: count,
        rows: Type.Array(
          Type.Object({ ...TerminalPaRowSchema.properties, terminalType: Type.String() }, strict),
          { maxItems: 10000 },
        ),
      },
      strict,
    ),
  },
  strict,
);
export type TerminalBattingGroup = Static<typeof TerminalBattingGroupSchema>;
export type BatterProfileResponse = Static<typeof BatterProfileResponseSchema>;
