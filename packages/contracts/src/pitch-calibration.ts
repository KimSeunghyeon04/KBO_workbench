import { type Static, Type } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const count = Type.Integer({ minimum: 0 });
const id = Type.String({ minLength: 1, maxLength: 200 });

export const PITCH_CALIBRATION_PARAMETERS = {
  modelVersion: 1,
  windowDays: 84,
  halfLifeDays: 7,
  minCellPitches: 5,
  maxCellWeight: 30,
  minGames: 5,
  minPitchers: 20,
  plateYFeet: 17 / 24,
} as const;

export const PitchCalibrationCoefficientSchema = Type.Object(
  {
    parkId: id,
    lateralBias: Type.Number(),
    verticalBias: Type.Number(),
    lateralStandardError: Type.Number({ minimum: 0 }),
    verticalStandardError: Type.Number({ minimum: 0 }),
    games: count,
    pitchers: count,
    pitches: count,
    cells: count,
  },
  strict,
);
export const PitchCalibrationProfileSchema = Type.Object(
  {
    asOf: date,
    windowStart: date,
    inputHash: hash,
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("insufficient_data"),
      Type.Literal("unidentifiable"),
    ]),
    lastTrainingDate: Type.Union([date, Type.Null()]),
    trainingCells: count,
    trainingGames: count,
    trainingPitchers: count,
    coefficients: Type.Array(PitchCalibrationCoefficientSchema),
    // Order is coefficient park order, with lateral then vertical for each park.
    covariance: Type.Array(Type.Array(Type.Number())),
  },
  strict,
);
export const PitchCalibrationKeySchema = Type.Object(
  {
    modelVersion: Type.Literal(PITCH_CALIBRATION_PARAMETERS.modelVersion),
    season: Type.Integer({ minimum: 1900, maximum: 2200 }),
    sourceHash: hash,
  },
  strict,
);
export const PitchCalibrationSeasonSchema = Type.Object(
  {
    ...PitchCalibrationKeySchema.properties,
    profiles: Type.Array(PitchCalibrationProfileSchema),
  },
  strict,
);
export const PitchCalibrationEnvelopeSchema = Type.Object(
  { hash, payload: PitchCalibrationSeasonSchema },
  strict,
);
export const PitchCalibrationStatusSchema = Type.Union([
  Type.Literal("applied"),
  Type.Literal("insufficient_data"),
  Type.Literal("unsupported_park"),
]);
export const PitchCalibrationSummarySchema = Type.Object(
  {
    modelVersion: Type.Literal(PITCH_CALIBRATION_PARAMETERS.modelVersion),
    profileHash: hash,
    windowDays: Type.Literal(PITCH_CALIBRATION_PARAMETERS.windowDays),
    halfLifeDays: Type.Literal(PITCH_CALIBRATION_PARAMETERS.halfLifeDays),
    plane: Type.Literal("middle"),
    calibratedCount: count,
    uncalibratedCount: count,
  },
  strict,
);

export type PitchCalibrationCoefficient = Static<typeof PitchCalibrationCoefficientSchema>;
export type PitchCalibrationProfile = Static<typeof PitchCalibrationProfileSchema>;
export type PitchCalibrationKey = Static<typeof PitchCalibrationKeySchema>;
export type PitchCalibrationSeason = Static<typeof PitchCalibrationSeasonSchema>;
export type PitchCalibrationStatus = Static<typeof PitchCalibrationStatusSchema>;
