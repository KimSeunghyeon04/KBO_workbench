import type { PlateResult } from "@kbo/contracts";

export const BATTED_BALL_CASES = [
  ["single", true],
  ["double", true],
  ["triple", true],
  ["home_run", true],
  ["walk", false],
  ["intentional_walk", false],
  ["hit_by_pitch", false],
  ["strikeout", false],
  ["field_out", true],
  ["sacrifice_bunt", true],
  ["sacrifice_fly", true],
  ["fielder_choice", true],
  ["reached_on_error", true],
  ["interference", false],
  ["double_play", true],
  ["triple_play", true],
  ["other", true],
] as const satisfies readonly (readonly [PlateResult, boolean])[];
