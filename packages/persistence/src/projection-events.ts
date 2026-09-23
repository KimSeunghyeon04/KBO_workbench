import type { StagingRelayEvent } from "@kbo/contracts";
import { parseStagingRelayEvent } from "@kbo/contracts";
import { PersistenceIntegrityError } from "./errors.js";
import {
  boolean,
  half,
  number,
  pitchMetadataFromRow,
  relayEventKind,
  side,
  text,
} from "./projection-values.js";
import type { ProjectionRow, ProjectionTables } from "./projection.js";

const RELAY_SUBTYPE_TABLES = {
  half_inning_start: "relay_half_inning_starts",
  batter_start: "relay_batter_starts",
  pitch: "relay_pitches",
  plate_result: "relay_plate_results",
  runner_advance: "relay_runner_advances",
  substitution: "relay_substitutions",
  review: "relay_reviews",
  administrative: "relay_administrative",
  unresolved: "relay_unresolved",
} as const satisfies Record<StagingRelayEvent["kind"], keyof ProjectionTables>;

export function hydrateEvents(tables: ProjectionTables): StagingRelayEvent[] {
  const subtypeByTable = new Map<keyof ProjectionTables, Map<string, ProjectionRow>>();
  for (const table of Object.values(RELAY_SUBTYPE_TABLES)) {
    subtypeByTable.set(
      table,
      new Map(
        tables[table].map((row) => [`${String(row.event_sequence)}:${String(row.event_id)}`, row]),
      ),
    );
  }
  return tables.relay_event_facts.map((header) => {
    const kind = relayEventKind(header.kind);
    const table = RELAY_SUBTYPE_TABLES[kind];
    if (table === undefined) {
      throw new PersistenceIntegrityError(`알 수 없는 relay kind: ${kind}`);
    }
    const key = `${String(header.event_sequence)}:${String(header.event_id)}`;
    const subtype = subtypeByTable.get(table)?.get(key);
    if (subtype === undefined) {
      throw new PersistenceIntegrityError(`relay subtype이 없습니다: ${kind}:${key}`);
    }
    return hydrateEvent({ ...header, ...subtype });
  });
}

function hydrateEvent(row: ProjectionRow): StagingRelayEvent {
  const identity =
    row.identity_kind === "source"
      ? {
          kind: "source" as const,
          eventId: text(row.event_id),
          endpoint: text(row.source_endpoint),
          blockIndex: number(row.source_block_index),
          eventIndex: number(row.source_event_index),
          ...(row.source_event_id === null ? {} : { sourceEventId: text(row.source_event_id) }),
        }
      : { kind: "manual" as const, eventId: text(row.event_id) };
  const observedStateAfter = hydrateObserved(row);
  const base = {
    identity,
    sequence: number(row.event_sequence),
    inning: number(row.inning),
    half: half(row.half),
    ...(row.relay_text === null ? {} : { relayText: text(row.relay_text) }),
    ...(observedStateAfter === undefined ? {} : { observedStateAfter }),
  };
  switch (row.kind) {
    case "half_inning_start":
      return hydratedRelayEvent({ ...base, kind: "half_inning_start", payload: {} });
    case "batter_start":
      return hydratedRelayEvent({
        ...base,
        kind: "batter_start",
        payload: { batterId: text(row.batter_id), pitcherId: text(row.pitcher_id) },
      });
    case "pitch":
      return hydratedRelayEvent({
        ...base,
        kind: "pitch",
        payload: {
          ...pitchMetadataFromRow(row),
          call: text(row.pitch_call),
          ...(row.source_pitch_id === null ? {} : { sourcePitchId: text(row.source_pitch_id) }),
          ...(row.batter_id === null ? {} : { batterId: text(row.batter_id) }),
          ...(row.pitcher_id === null ? {} : { pitcherId: text(row.pitcher_id) }),
        },
      });
    case "plate_result":
      return hydratedRelayEvent({
        ...base,
        kind: "plate_result",
        payload: {
          result: text(row.plate_result),
          batterId: text(row.batter_id),
          pitcherId: text(row.pitcher_id),
          ...(row.credited_rbi === null ? {} : { creditedRbi: number(row.credited_rbi) }),
          ...(row.outs_recorded === null ? {} : { outsRecorded: number(row.outs_recorded) }),
          ...(row.batter_destination === null
            ? {}
            : { batterDestination: number(row.batter_destination) }),
          ...(row.batted_ball_type === null
            ? {}
            : {
                battedBallType: text(row.batted_ball_type),
              }),
          ...(row.is_bunt === null ? {} : { isBunt: boolean(row.is_bunt) }),
        },
      });
    case "runner_advance":
      return hydratedRelayEvent({
        ...base,
        kind: "runner_advance",
        payload: {
          runnerId: text(row.runner_id),
          fromBase: number(row.from_base),
          toBase: number(row.to_base),
          outcome: text(row.runner_outcome),
          ...(row.runner_out_kind === null
            ? {}
            : {
                outKind: text(row.runner_out_kind),
              }),
          ...(row.supersedes_third_out === null
            ? {}
            : { supersedesThirdOut: boolean(row.supersedes_third_out) }),
          ...(row.responsible_pitcher_id === null
            ? {}
            : { responsiblePitcherId: text(row.responsible_pitcher_id) }),
          context:
            row.runner_context_kind === "plate_result"
              ? { kind: "plate_result", plateResultEventId: text(row.plate_result_event_id) }
              : {
                  kind: "independent",
                  reason: text(row.runner_reason),
                },
        },
      });
    case "substitution":
      return hydratedRelayEvent({
        ...base,
        kind: "substitution",
        payload: {
          side: side(row.substitution_side),
          role: text(row.substitution_role),
          incomingPlayerId: text(row.incoming_player_id),
          ...(row.outgoing_player_id === null
            ? {}
            : { outgoingPlayerId: text(row.outgoing_player_id) }),
          ...(row.batting_order === null ? {} : { battingOrder: number(row.batting_order) }),
          ...(row.field_position === null ? {} : { fieldPosition: text(row.field_position) }),
        },
      });
    case "review":
      return hydratedRelayEvent({
        ...base,
        kind: "review",
        payload: {
          ...(row.review_decision === null
            ? {}
            : {
                decision: text(row.review_decision),
              }),
          ...(row.reviewed_event_id === null
            ? {}
            : { reviewedEventId: text(row.reviewed_event_id) }),
        },
      });
    case "administrative":
      return hydratedRelayEvent({
        ...base,
        kind: "administrative",
        payload: {
          code: text(row.administrative_code),
        },
      });
    case "unresolved":
      return hydratedRelayEvent({
        ...base,
        kind: "unresolved",
        payload: {
          sourceType: text(row.unresolved_source_type),
          ...(row.suspected_kind === null
            ? {}
            : {
                suspectedKind: text(row.suspected_kind),
              }),
        },
      });
    default:
      throw new PersistenceIntegrityError(`알 수 없는 relay kind: ${String(row.kind)}`);
  }
}

function hydratedRelayEvent(value: unknown): StagingRelayEvent {
  try {
    return parseStagingRelayEvent(value);
  } catch (error: unknown) {
    throw new PersistenceIntegrityError(
      `DB relay event가 계약을 위반합니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
    );
  }
}

function hydrateObserved(row: ProjectionRow): StagingRelayEvent["observedStateAfter"] {
  const values = [
    row.observed_balls,
    row.observed_strikes,
    row.observed_outs,
    row.observed_base1,
    row.observed_base2,
    row.observed_base3,
    row.observed_away_score,
    row.observed_home_score,
  ];
  if (values.every((value) => value === null)) return undefined;
  const basesPresent = [row.observed_base1, row.observed_base2, row.observed_base3].some(
    (value) => value !== null,
  );
  const bases: [string | boolean | null, string | boolean | null, string | boolean | null] = [
    observedBase(row.observed_base1),
    observedBase(row.observed_base2),
    observedBase(row.observed_base3),
  ];
  return {
    ...(row.observed_balls === null ? {} : { balls: number(row.observed_balls) }),
    ...(row.observed_strikes === null ? {} : { strikes: number(row.observed_strikes) }),
    ...(row.observed_outs === null ? {} : { outs: number(row.observed_outs) }),
    ...(basesPresent
      ? {
          bases,
        }
      : {}),
    ...(row.observed_away_score === null ? {} : { awayScore: number(row.observed_away_score) }),
    ...(row.observed_home_score === null ? {} : { homeScore: number(row.observed_home_score) }),
  };
}

function observedBase(value: unknown): string | boolean | null {
  if (value === null) return null;
  if (value === "*") return true;
  if (value === "") return false;
  return text(value);
}
