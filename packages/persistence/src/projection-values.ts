import type { StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";
import type {
  CompiledPitchFact,
  CompiledPlay,
  Finding,
  PlateAppearanceSummary,
} from "@kbo/game-core";
import { PersistenceIntegrityError } from "./errors.js";
import { PROJECTION_ENUM_VALUES } from "./projection-descriptor.js";
import type { ProjectionRow, ProjectionTables } from "./projection.js";

export function teamsFromProjection(tables: ProjectionTables): StagingGameDocumentV2["teams"] {
  if (tables.game_team_snapshots.length !== 2) {
    throw new PersistenceIntegrityError("game_team_snapshots는 away/home 두 행이어야 합니다.");
  }
  const team = (teamSide: "away" | "home") => {
    const rows = tables.game_team_snapshots.filter((row) => side(row.side) === teamSide);
    const row = requiredSingle(rows, `game_team_snapshots.${teamSide}`);
    return { teamId: text(row.team_id), name: text(row.team_name) };
  };
  return { away: team("away"), home: team("home") };
}

export function trackingNumbersFromRow(
  row: ProjectionRow,
): Partial<StagingGameDocumentV2["trackingCandidates"][number]> {
  return {
    ...(row.x0 === null ? {} : { x0: number(row.x0) }),
    ...(row.y0 === null ? {} : { y0: number(row.y0) }),
    ...(row.z0 === null ? {} : { z0: number(row.z0) }),
    ...(row.vx0 === null ? {} : { vx0: number(row.vx0) }),
    ...(row.vy0 === null ? {} : { vy0: number(row.vy0) }),
    ...(row.vz0 === null ? {} : { vz0: number(row.vz0) }),
    ...(row.ax === null ? {} : { ax: number(row.ax) }),
    ...(row.ay === null ? {} : { ay: number(row.ay) }),
    ...(row.az === null ? {} : { az: number(row.az) }),
    ...(row.cross_plate_x === null ? {} : { crossPlateX: number(row.cross_plate_x) }),
    ...(row.cross_plate_y === null ? {} : { crossPlateY: number(row.cross_plate_y) }),
    ...(row.top_sz === null ? {} : { topSz: number(row.top_sz) }),
    ...(row.bottom_sz === null ? {} : { bottomSz: number(row.bottom_sz) }),
  };
}

export function requiredSingle(rows: readonly ProjectionRow[], table: string): ProjectionRow {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new PersistenceIntegrityError(`${table}은 정확히 한 행이어야 합니다.`);
  return rows[0];
}

export function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

export function requiredNullableText(value: unknown, label: string): string {
  const result = nullableText(value);
  if (result === null) throw new PersistenceIntegrityError(`${label} fact가 없습니다.`);
  return result;
}

export function requiredNullableNumber(value: unknown, label: string): number {
  if (value === null) throw new PersistenceIntegrityError(`${label} fact가 없습니다.`);
  return number(value);
}

export function pitchMetadataFromRow(row: ProjectionRow): {
  speedKph?: number;
  pitchType?: string;
} {
  return {
    ...(row.speed_kph === undefined || row.speed_kph === null
      ? {}
      : { speedKph: number(row.speed_kph) }),
    ...(row.pitch_type === undefined || row.pitch_type === null
      ? {}
      : { pitchType: text(row.pitch_type) }),
  };
}

export function group(
  rows: readonly ProjectionRow[],
  key: (row: ProjectionRow) => string,
): Map<string, ProjectionRow[]> {
  const result = new Map<string, ProjectionRow[]>();
  for (const row of rows) {
    const item = result.get(key(row)) ?? [];
    item.push(row);
    result.set(key(row), item);
  }
  return result;
}

export function text(value: unknown): string {
  if (typeof value !== "string")
    throw new PersistenceIntegrityError("DB text 값이 올바르지 않습니다.");
  return value;
}

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PersistenceIntegrityError("DB number 값이 올바르지 않습니다.");
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new PersistenceIntegrityError("DB boolean 값이 올바르지 않습니다.");
  return value;
}

export function side(value: unknown): "away" | "home" {
  const item = text(value);
  if (item !== "away" && item !== "home")
    throw new PersistenceIntegrityError("DB side 값이 올바르지 않습니다.");
  return item;
}

export function half(value: unknown): "top" | "bottom" {
  const item = text(value);
  if (item !== "top" && item !== "bottom")
    throw new PersistenceIntegrityError("DB half 값이 올바르지 않습니다.");
  return item;
}

const RUNNER_MOVEMENT_REASONS = [...PROJECTION_ENUM_VALUES.runnerReason, "plate_result"] as const;

function isOneOf<const Item extends string>(
  value: string,
  candidates: readonly Item[],
): value is Item {
  return candidates.some((candidate) => candidate === value);
}

function enumText<const Item extends string>(
  value: unknown,
  candidates: readonly Item[],
  label: string,
): Item {
  const item = text(value);
  if (!isOneOf(item, candidates)) {
    throw new PersistenceIntegrityError(`DB ${label} 값이 올바르지 않습니다: ${item}`);
  }
  return item;
}

export function relayEventKind(value: unknown): StagingRelayEvent["kind"] {
  return enumText(value, PROJECTION_ENUM_VALUES.relayKind, "relay kind");
}

export function pitchCall(value: unknown): CompiledPitchFact["call"] {
  return enumText(value, PROJECTION_ENUM_VALUES.pitchCall, "pitch call");
}

export function plateResult(value: unknown): NonNullable<PlateAppearanceSummary["result"]> {
  return enumText(value, PROJECTION_ENUM_VALUES.plateResult, "plate result");
}

export function runnerOutcome(value: unknown): CompiledPlay["movements"][number]["outcome"] {
  return enumText(value, PROJECTION_ENUM_VALUES.runnerOutcome, "runner outcome");
}

export function runnerOutKind(
  value: unknown,
): NonNullable<CompiledPlay["movements"][number]["outKind"]> {
  return enumText(value, PROJECTION_ENUM_VALUES.runnerOutKind, "runner out kind");
}

export function runnerMovementReason(value: unknown): CompiledPlay["movements"][number]["reason"] {
  return enumText(value, RUNNER_MOVEMENT_REASONS, "runner movement reason");
}

export function plateAppearanceTerminationReason(
  value: unknown,
): PlateAppearanceSummary["terminationReason"] {
  return enumText(value, PROJECTION_ENUM_VALUES.terminationReason, "PA termination reason");
}

export function trackingExclusionReason(
  value: unknown,
): "not_a_pitch" | "provider_conflict" | "invalid_measurement" | "manual_other" {
  return enumText(
    value,
    PROJECTION_ENUM_VALUES.trackingExclusionReason,
    "tracking exclusion reason",
  );
}

export function stance(value: unknown): "L" | "R" | "S" {
  return enumText(value, PROJECTION_ENUM_VALUES.stance, "stance");
}

export function findingCategory(value: unknown): Finding["category"] {
  const item = text(value);
  if (item !== "source" && item !== "domain" && item !== "persistence") {
    throw new PersistenceIntegrityError("DB finding category 값이 올바르지 않습니다.");
  }
  return item;
}

export function findingSeverity(value: unknown): Finding["severity"] {
  const item = text(value);
  if (item !== "warning" && item !== "blocking") {
    throw new PersistenceIntegrityError("DB finding severity 값이 올바르지 않습니다.");
  }
  return item;
}

export function dateText(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}
