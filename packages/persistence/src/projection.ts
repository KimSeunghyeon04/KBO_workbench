import { createHash } from "node:crypto";

import {
  canonicalStringify,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { applyPitchCall, type GameState, type ReplayResult } from "@kbo/game-core";

export type ProjectionScalar = string | number | boolean | null;
export type ProjectionRow = Readonly<Record<string, ProjectionScalar>>;
import {
  projectionTableColumns,
  type ProjectionTableName,
  type ProjectionVersion,
} from "./projection-descriptor.js";

export {
  decodeProjectionRow,
  PROJECTION_TABLE_COLUMNS,
  PROJECTION_TABLE_DESCRIPTORS,
} from "./projection-descriptor.js";
export type { ProjectionTableName } from "./projection-descriptor.js";
export type ProjectionTables = Readonly<Record<ProjectionTableName, readonly ProjectionRow[]>>;
export type { ProjectionVersion } from "./projection-descriptor.js";
type RelaySubtypeTableName =
  | "relay_half_inning_starts"
  | "relay_batter_starts"
  | "relay_pitches"
  | "relay_plate_results"
  | "relay_runner_advances"
  | "relay_substitutions"
  | "relay_reviews"
  | "relay_administrative"
  | "relay_unresolved";
export interface ProjectionCounts {
  readonly [key: string]: number;
}
export interface RelationalProjection {
  readonly version: ProjectionVersion;
  readonly tables: ProjectionTables;
  readonly counts: ProjectionCounts;
  readonly projectionHash: string;
}

class ProjectionShapeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectionShapeError";
  }
}

export function buildRelationalProjection(
  document: StagingGameDocumentV2,
  replay: ReplayResult,
  revision: number,
  version: ProjectionVersion = 4,
): RelationalProjection {
  if (
    version === 3 &&
    document.events.some(
      (event) =>
        event.kind === "pitch" &&
        (event.payload.speedKph !== undefined || event.payload.pitchType !== undefined),
    )
  ) {
    throw new ProjectionShapeError("V3 projection에는 투구 metadata를 저장할 수 없습니다.");
  }
  const gameId = document.metadata.gameId;
  const teams: ProjectionRow[] = (["away", "home"] as const).map((side) => ({
    game_id: gameId,
    revision,
    side,
    team_id: document.teams[side].teamId,
    team_name: document.teams[side].name,
  }));
  const rosters: ProjectionRow[] = [];
  const positions: ProjectionRow[] = [];
  for (const side of ["away", "home"] as const) {
    document.rosters[side].players.forEach((player, rosterIndex) => {
      rosters.push({
        game_id: gameId,
        revision,
        side,
        roster_index: rosterIndex,
        player_id: player.playerId,
        player_name: player.name,
        batting_order: player.battingOrder ?? null,
        starter: player.starter,
      });
      player.positions.forEach((position, positionIndex) =>
        positions.push({
          game_id: gameId,
          revision,
          side,
          roster_index: rosterIndex,
          position_index: positionIndex,
          position,
        }),
      );
    });
  }
  const relay = document.events.map((event) => relayEventRow(gameId, revision, event));
  const relaySubtypes: Record<RelaySubtypeTableName, ProjectionRow[]> = {
    relay_half_inning_starts: [],
    relay_batter_starts: [],
    relay_pitches: [],
    relay_plate_results: [],
    relay_runner_advances: [],
    relay_substitutions: [],
    relay_reviews: [],
    relay_administrative: [],
    relay_unresolved: [],
  };
  for (const event of document.events) {
    const subtype = relaySubtypeRow(gameId, revision, event, version);
    relaySubtypes[subtype.table].push(subtype.row);
  }
  const pitchFacts: ProjectionRow[] = replay.pitchFacts.map((pitch, pitchSequence) => ({
    game_id: gameId,
    revision,
    pitch_sequence: pitchSequence,
    pitch_id: pitch.pitchId,
    plate_appearance_event_id: pitch.plateAppearanceEventId,
    pitch_event_number: pitch.pitchEventNumber,
    actual_pitch_number: pitch.actualPitchNumber,
    inning: pitch.inning,
    half: pitch.half,
    batter_id: pitch.batterId,
    pitcher_id: pitch.pitcherId,
    source_pitch_id: pitch.sourcePitchId,
    ...(version === 3
      ? {}
      : { speed_kph: pitch.speedKph ?? null, pitch_type: pitch.pitchType ?? null }),
    pitch_call: pitch.call,
    actual: pitch.actual,
    ball: pitch.ball,
    called_strike: pitch.calledStrike,
    swing: pitch.swing,
    whiff: pitch.whiff,
    foul: pitch.foul,
    in_play: pitch.inPlay,
    strike: pitch.strike,
    csw: pitch.csw,
    ...pitchStateRow("before", pitch.before),
    ...pitchStateRow("after", pitch.after),
  }));
  const trackingCandidates: ProjectionRow[] = [];
  const tracking: ProjectionRow[] = [];
  document.trackingCandidates.forEach((candidate, trackingSequence) => {
    trackingCandidates.push({
      game_id: gameId,
      revision,
      tracking_sequence: trackingSequence,
      tracking_id: candidate.trackingId,
      measurement_profile_id: "naver_pts_v1",
      source_pitch_id: candidate.sourcePitchId ?? null,
      source_pitch_ordinal: candidate.sourcePitchOrdinal,
      source_endpoint: candidate.source.endpoint,
      source_block_index: candidate.source.blockIndex,
      source_row_index: candidate.source.rowIndex,
      inning: candidate.inning,
      half: candidate.half,
      plate_appearance_event_id: candidate.plateAppearanceEventId ?? null,
      pitcher_id: candidate.pitcherId ?? null,
      batter_id: candidate.batterId ?? null,
      observed_at: candidate.observedAt ?? null,
      stance: candidate.stance ?? null,
      x0: candidate.x0 ?? null,
      y0: candidate.y0 ?? null,
      z0: candidate.z0 ?? null,
      vx0: candidate.vx0 ?? null,
      vy0: candidate.vy0 ?? null,
      vz0: candidate.vz0 ?? null,
      ax: candidate.ax ?? null,
      ay: candidate.ay ?? null,
      az: candidate.az ?? null,
      cross_plate_x: candidate.crossPlateX ?? null,
      cross_plate_y: candidate.crossPlateY ?? null,
      top_sz: candidate.topSz ?? null,
      bottom_sz: candidate.bottomSz ?? null,
      resolution_kind: candidate.resolution.kind,
      pitch_event_id:
        candidate.resolution.kind === "linked" ? candidate.resolution.pitchEventId : null,
      canonical_tracking_id:
        candidate.resolution.kind === "duplicate" ? candidate.resolution.canonicalTrackingId : null,
      exclusion_reason:
        candidate.resolution.kind === "excluded" ? candidate.resolution.reason : null,
      exclusion_note:
        candidate.resolution.kind === "excluded" ? (candidate.resolution.note ?? null) : null,
    });
    if (candidate.resolution.kind !== "linked") return;
    tracking.push({
      game_id: gameId,
      revision,
      tracking_sequence: trackingSequence,
      pitch_id: candidate.resolution.pitchEventId,
      tracking_id: candidate.trackingId,
    });
  });
  const officialBatters = document.officialRecords.batters.map((line, recordIndex) => ({
    game_id: gameId,
    revision,
    record_index: recordIndex,
    ...batterLineRow(line),
  }));
  const officialPitchers = document.officialRecords.pitchers.map((line, recordIndex) => ({
    game_id: gameId,
    revision,
    record_index: recordIndex,
    ...pitcherLineRow(line, line.earnedRuns),
  }));
  const playFacts: ProjectionRow[] = [];
  const playEvents: ProjectionRow[] = [];
  const movements: ProjectionRow[] = [];
  const eventSequence = new Map(
    document.events.map((event) => [event.identity.eventId, event.sequence]),
  );
  const relayText = new Map(
    document.events.map((event) => [event.identity.eventId, event.relayText ?? null]),
  );
  replay.plays.forEach((play, playSequence) => {
    playFacts.push({
      game_id: gameId,
      revision,
      play_sequence: playSequence,
      play_id: play.playId,
      source_sequence: play.sequence,
      kind: play.kind,
      inning: play.inning,
      half: play.half,
      applied: play.applied,
      ...stateRow("before", play.before),
      ...stateRow("after", play.after),
    });
    play.relayEventIds.forEach((eventId, relayOrder) =>
      playEvents.push({
        game_id: gameId,
        revision,
        play_sequence: playSequence,
        relay_order: relayOrder,
        event_sequence: eventSequence.get(eventId) ?? -1,
        event_id: eventId,
        relay_text: relayText.get(eventId) ?? null,
      }),
    );
    play.movements.forEach((movement, movementSequence) =>
      movements.push({
        game_id: gameId,
        revision,
        play_sequence: playSequence,
        movement_id: movement.movementId,
        movement_sequence: movementSequence,
        source_event_id: movement.sourceEventId,
        source_sequence: movement.sequence,
        runner_id: movement.runnerId,
        from_base: movement.fromBase,
        to_base: movement.toBase,
        outcome: movement.outcome,
        out_kind: movement.outKind ?? null,
        supersedes_third_out: movement.supersedesThirdOut ?? null,
        responsible_pitcher_id: movement.responsiblePitcherId,
        reason: movement.reason,
        derived: movement.derived,
      }),
    );
  });
  const plateAppearances: ProjectionRow[] = [];
  const plateEvents: ProjectionRow[] = [];
  const pitchEvents = new Map(
    document.events
      .filter((event) => event.kind === "pitch")
      .map((event) => [event.identity.eventId, event]),
  );
  replay.plateAppearances.forEach((pa, plateAppearanceIndex) => {
    const resultEvent =
      pa.endEventId === null
        ? undefined
        : document.events.find(
            (event) => event.identity.eventId === pa.endEventId && event.kind === "plate_result",
          );
    plateAppearances.push({
      game_id: gameId,
      revision,
      plate_appearance_index: plateAppearanceIndex,
      start_event_id: pa.startEventId,
      end_event_id: pa.endEventId,
      inning: pa.inning,
      half: pa.half,
      start_batter_id: pa.startBatterId,
      batter_id: pa.batterId,
      start_pitcher_id: pa.startPitcherId,
      pitcher_id: pa.pitcherId,
      result: pa.result,
      batted_ball_type:
        resultEvent?.kind === "plate_result" ? (resultEvent.payload.battedBallType ?? null) : null,
      is_bunt: resultEvent?.kind === "plate_result" ? (resultEvent.payload.isBunt ?? null) : null,
      completed: pa.completed,
      termination_reason: pa.terminationReason,
      actual_pitch_count: pa.actualPitchCount,
      counts_as_plate_appearance: pa.completed,
      counts_as_at_bat: pa.completed && countsAsAtBat(pa.result),
      counts_as_batter_faced: pa.completed,
    });
    let pitchEventNumber = 0;
    let pitchNumber = 0;
    pa.eventIds.forEach((eventId, eventNumber) => {
      const pitch = pitchEvents.get(eventId);
      if (pitch !== undefined) pitchEventNumber += 1;
      const isActualPitch =
        pitch !== undefined && applyPitchCall(0, 0, pitch.payload.call).isActualPitch;
      if (isActualPitch) pitchNumber += 1;
      plateEvents.push({
        game_id: gameId,
        revision,
        plate_appearance_index: plateAppearanceIndex,
        event_number: eventNumber,
        event_id: eventId,
        event_sequence: eventSequence.get(eventId) ?? -1,
        pitch_event_number: pitch === undefined ? null : pitchEventNumber,
        pitch_number: isActualPitch ? pitchNumber : null,
      });
    });
  });
  const computedBatters = replay.batterLines.map((line, lineIndex) => ({
    game_id: gameId,
    revision,
    line_index: lineIndex,
    ...batterLineRow(line),
  }));
  const officialEarnedRuns = new Map(
    document.officialRecords.pitchers.map((line) => [line.playerId, line.earnedRuns]),
  );
  const computedPitchers = replay.pitcherLines.map((line, lineIndex) => ({
    game_id: gameId,
    revision,
    line_index: lineIndex,
    ...pitcherLineRow(line, officialEarnedRuns.get(line.playerId) ?? null, "official_earned_runs"),
  }));
  const baserunners = replay.baserunnerLines.map((line, lineIndex) => ({
    game_id: gameId,
    revision,
    line_index: lineIndex,
    player_id: line.playerId,
    side: line.side,
    advances: line.advances,
    extra_bases_taken: line.extraBasesTaken,
    runs: line.runs,
    stolen_bases: line.stolenBases,
    caught_stealing: line.caughtStealing,
    pickoffs: line.pickoffs,
  }));
  const validationIssues: ProjectionRow[] = [];
  const validationDetails: ProjectionRow[] = [];
  replay.findings.forEach((finding, issueIndex) => {
    validationIssues.push({
      game_id: gameId,
      revision,
      issue_index: issueIndex,
      code: finding.code,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      event_id: finding.eventId ?? null,
      event_sequence: finding.eventSequence ?? null,
      record_identity: finding.recordIdentity ?? null,
    });
    finding.details.forEach((detail, detailIndex) =>
      validationDetails.push({
        game_id: gameId,
        revision,
        issue_index: issueIndex,
        detail_index: detailIndex,
        field: detail.field,
        ...prefixedScalar("expected", detail.expected),
        ...prefixedScalar("actual", detail.actual),
      }),
    );
  });
  const tables = normalizeProjectionTables(
    {
      game_team_snapshots: teams,
      game_roster_snapshots: rosters,
      game_roster_positions: positions,
      relay_event_facts: relay,
      ...relaySubtypes,
      tracking_observations: trackingCandidates,
      pitch_facts: pitchFacts,
      pitch_tracking_links: tracking,
      official_batter_lines: officialBatters,
      official_pitcher_lines: officialPitchers,
      play_facts: playFacts,
      play_events: playEvents,
      runner_movement_facts: movements,
      game_final_states: [{ game_id: gameId, revision, ...stateRow("final", replay.finalState) }],
      plate_appearance_facts: plateAppearances,
      plate_appearance_events: plateEvents,
      batter_game_facts: computedBatters,
      pitcher_game_facts: computedPitchers,
      baserunner_game_facts: baserunners,
      validation_runs: [
        {
          game_id: gameId,
          revision,
          blocking_count: replay.findings.filter((finding) => finding.severity === "blocking")
            .length,
          warning_count: replay.findings.filter((finding) => finding.severity === "warning").length,
          issue_count: replay.findings.length,
        },
      ],
      validation_issues: validationIssues,
      validation_issue_details: validationDetails,
    },
    version,
  );
  const counts = projectionCounts(tables);
  return { version, tables, counts, projectionHash: hashNormalizedProjectionTables(tables) };
}

export function projectionCounts(tables: ProjectionTables): ProjectionCounts {
  return mapProjectionTables((table) => tables[table].length);
}
export function hashProjectionTables(
  tables: ProjectionTables,
  version: ProjectionVersion = 4,
): string {
  return hashNormalizedProjectionTables(normalizeProjectionTables(tables, version));
}

function hashNormalizedProjectionTables(tables: ProjectionTables): string {
  return createHash("sha256")
    .update(canonicalStringify(mapProjectionTables((table) => tables[table])), "utf8")
    .digest("hex");
}

export function normalizeProjectionTables(
  tables: ProjectionTables,
  version: ProjectionVersion = 4,
): ProjectionTables {
  return mapProjectionTables((table) => {
    const columns = projectionTableColumns(table, version);
    const rows = tables[table];
    if (!Array.isArray(rows)) {
      throw new ProjectionShapeError(`${table} projection table이 배열이 아닙니다.`);
    }
    return rows.map((row, rowIndex) => normalizeProjectionRow(table, rowIndex, columns, row));
  });
}

function normalizeProjectionRow(
  table: ProjectionTableName,
  rowIndex: number,
  columns: readonly string[],
  row: ProjectionRow,
): ProjectionRow {
  const columnSet = new Set<string>(columns);
  const rowKeys = Object.keys(row);
  const missing = columns.filter((column) => !Object.hasOwn(row, column));
  const extra = rowKeys.filter((column) => !columnSet.has(column));
  const undefinedColumns = columns.filter(
    (column) => Object.hasOwn(row, column) && row[column] === undefined,
  );
  const invalidColumns = columns.filter((column) => {
    const value = row[column];
    return value !== undefined && !isProjectionScalar(value);
  });
  if (
    missing.length > 0 ||
    extra.length > 0 ||
    undefinedColumns.length > 0 ||
    invalidColumns.length > 0
  ) {
    const details = [
      missing.length === 0 ? null : `누락=${missing.join(",")}`,
      extra.length === 0 ? null : `초과=${extra.join(",")}`,
      undefinedColumns.length === 0 ? null : `undefined=${undefinedColumns.join(",")}`,
      invalidColumns.length === 0 ? null : `타입 오류=${invalidColumns.join(",")}`,
    ].filter((detail): detail is string => detail !== null);
    throw new ProjectionShapeError(
      `${table}[${String(rowIndex)}] projection column 불일치: ${details.join("; ")}`,
    );
  }
  const normalized: Record<string, ProjectionScalar> = {};
  for (const column of columns) {
    const value = row[column];
    if (!isProjectionScalar(value)) {
      throw new ProjectionShapeError(
        `${table}[${String(rowIndex)}] ${column} projection scalar가 올바르지 않습니다.`,
      );
    }
    normalized[column] = value;
  }
  return normalized;
}

function mapProjectionTables<Value>(
  mapper: (table: ProjectionTableName) => Value,
): Record<ProjectionTableName, Value> {
  return {
    game_team_snapshots: mapper("game_team_snapshots"),
    game_roster_snapshots: mapper("game_roster_snapshots"),
    game_roster_positions: mapper("game_roster_positions"),
    relay_event_facts: mapper("relay_event_facts"),
    relay_half_inning_starts: mapper("relay_half_inning_starts"),
    relay_batter_starts: mapper("relay_batter_starts"),
    relay_pitches: mapper("relay_pitches"),
    relay_plate_results: mapper("relay_plate_results"),
    relay_runner_advances: mapper("relay_runner_advances"),
    relay_substitutions: mapper("relay_substitutions"),
    relay_reviews: mapper("relay_reviews"),
    relay_administrative: mapper("relay_administrative"),
    relay_unresolved: mapper("relay_unresolved"),
    tracking_observations: mapper("tracking_observations"),
    pitch_facts: mapper("pitch_facts"),
    pitch_tracking_links: mapper("pitch_tracking_links"),
    official_batter_lines: mapper("official_batter_lines"),
    official_pitcher_lines: mapper("official_pitcher_lines"),
    play_facts: mapper("play_facts"),
    play_events: mapper("play_events"),
    runner_movement_facts: mapper("runner_movement_facts"),
    game_final_states: mapper("game_final_states"),
    plate_appearance_facts: mapper("plate_appearance_facts"),
    plate_appearance_events: mapper("plate_appearance_events"),
    batter_game_facts: mapper("batter_game_facts"),
    pitcher_game_facts: mapper("pitcher_game_facts"),
    baserunner_game_facts: mapper("baserunner_game_facts"),
    validation_runs: mapper("validation_runs"),
    validation_issues: mapper("validation_issues"),
    validation_issue_details: mapper("validation_issue_details"),
  };
}

function isProjectionScalar(value: unknown): value is ProjectionScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function relayEventRow(gameId: string, revision: number, event: StagingRelayEvent): ProjectionRow {
  const identity = event.identity;
  return {
    game_id: gameId,
    revision,
    event_sequence: event.sequence,
    event_id: identity.eventId,
    identity_kind: identity.kind,
    source_endpoint: identity.kind === "source" ? identity.endpoint : null,
    source_block_index: identity.kind === "source" ? identity.blockIndex : null,
    source_event_index: identity.kind === "source" ? identity.eventIndex : null,
    source_event_id: identity.kind === "source" ? (identity.sourceEventId ?? null) : null,
    kind: event.kind,
    inning: event.inning,
    half: event.half,
    relay_text: event.relayText ?? null,
    observed_balls: event.observedStateAfter?.balls ?? null,
    observed_strikes: event.observedStateAfter?.strikes ?? null,
    observed_outs: event.observedStateAfter?.outs ?? null,
    observed_base1: observedBase(event.observedStateAfter?.bases?.[0]),
    observed_base2: observedBase(event.observedStateAfter?.bases?.[1]),
    observed_base3: observedBase(event.observedStateAfter?.bases?.[2]),
    observed_away_score: event.observedStateAfter?.awayScore ?? null,
    observed_home_score: event.observedStateAfter?.homeScore ?? null,
  };
}

function relaySubtypeRow(
  gameId: string,
  revision: number,
  event: StagingRelayEvent,
  version: ProjectionVersion,
): { readonly table: RelaySubtypeTableName; readonly row: ProjectionRow } {
  const key = {
    game_id: gameId,
    revision,
    event_sequence: event.sequence,
    event_id: event.identity.eventId,
    kind: event.kind,
  };
  if (event.kind === "half_inning_start") {
    return { table: "relay_half_inning_starts", row: key };
  }
  if (event.kind === "batter_start") {
    return {
      table: "relay_batter_starts",
      row: { ...key, batter_id: event.payload.batterId, pitcher_id: event.payload.pitcherId },
    };
  }
  if (event.kind === "pitch") {
    return {
      table: "relay_pitches",
      row: {
        ...key,
        source_pitch_id: event.payload.sourcePitchId ?? null,
        ...(version === 3
          ? {}
          : {
              speed_kph: event.payload.speedKph ?? null,
              pitch_type: event.payload.pitchType ?? null,
            }),
        pitch_call: event.payload.call,
        batter_id: event.payload.batterId ?? null,
        pitcher_id: event.payload.pitcherId ?? null,
      },
    };
  }
  if (event.kind === "plate_result") {
    return {
      table: "relay_plate_results",
      row: {
        ...key,
        plate_result: event.payload.result,
        batter_id: event.payload.batterId,
        pitcher_id: event.payload.pitcherId,
        credited_rbi: event.payload.creditedRbi ?? null,
        outs_recorded: event.payload.outsRecorded ?? null,
        batter_destination: event.payload.batterDestination ?? null,
        batted_ball_type: event.payload.battedBallType ?? null,
        is_bunt: event.payload.isBunt ?? null,
      },
    };
  }
  if (event.kind === "runner_advance") {
    return {
      table: "relay_runner_advances",
      row: {
        ...key,
        runner_id: event.payload.runnerId,
        from_base: event.payload.fromBase,
        to_base: event.payload.toBase,
        runner_outcome: event.payload.outcome,
        runner_out_kind: event.payload.outKind ?? null,
        supersedes_third_out: event.payload.supersedesThirdOut ?? null,
        responsible_pitcher_id: event.payload.responsiblePitcherId ?? null,
        runner_context_kind: event.payload.context.kind,
        plate_result_event_id:
          event.payload.context.kind === "plate_result"
            ? event.payload.context.plateResultEventId
            : null,
        runner_reason:
          event.payload.context.kind === "independent" ? event.payload.context.reason : null,
      },
    };
  }
  if (event.kind === "substitution") {
    return {
      table: "relay_substitutions",
      row: {
        ...key,
        substitution_side: event.payload.side,
        substitution_role: event.payload.role,
        incoming_player_id: event.payload.incomingPlayerId,
        outgoing_player_id: event.payload.outgoingPlayerId ?? null,
        batting_order: event.payload.battingOrder ?? null,
        field_position: event.payload.fieldPosition ?? null,
      },
    };
  }
  if (event.kind === "review") {
    return {
      table: "relay_reviews",
      row: {
        ...key,
        review_decision: event.payload.decision ?? null,
        reviewed_event_id: event.payload.reviewedEventId ?? null,
      },
    };
  }
  if (event.kind === "administrative") {
    return {
      table: "relay_administrative",
      row: { ...key, administrative_code: event.payload.code },
    };
  }
  return {
    table: "relay_unresolved",
    row: {
      ...key,
      unresolved_source_type: event.payload.sourceType,
      suspected_kind: event.payload.suspectedKind ?? null,
    },
  };
}

function pitchStateRow(prefix: string, state: GameState): ProjectionRow {
  return {
    [`${prefix}_balls`]: state.balls,
    [`${prefix}_strikes`]: state.strikes,
    [`${prefix}_outs`]: state.outs,
    [`${prefix}_base1_runner_id`]: state.bases[0]?.runnerId ?? null,
    [`${prefix}_base2_runner_id`]: state.bases[1]?.runnerId ?? null,
    [`${prefix}_base3_runner_id`]: state.bases[2]?.runnerId ?? null,
    [`${prefix}_away_score`]: state.awayScore,
    [`${prefix}_home_score`]: state.homeScore,
  };
}
function stateRow(prefix: string, state: GameState): ProjectionRow {
  const plate = state.activePlateAppearance;
  return {
    [`${prefix}_inning`]: state.inning,
    [`${prefix}_half`]: state.half,
    [`${prefix}_half_active`]: state.halfActive,
    [`${prefix}_balls`]: state.balls,
    [`${prefix}_strikes`]: state.strikes,
    [`${prefix}_outs`]: state.outs,
    [`${prefix}_base1_runner_id`]: state.bases[0]?.runnerId ?? null,
    [`${prefix}_base1_pitcher_id`]: state.bases[0]?.responsiblePitcherId ?? null,
    [`${prefix}_base2_runner_id`]: state.bases[1]?.runnerId ?? null,
    [`${prefix}_base2_pitcher_id`]: state.bases[1]?.responsiblePitcherId ?? null,
    [`${prefix}_base3_runner_id`]: state.bases[2]?.runnerId ?? null,
    [`${prefix}_base3_pitcher_id`]: state.bases[2]?.responsiblePitcherId ?? null,
    [`${prefix}_away_score`]: state.awayScore,
    [`${prefix}_home_score`]: state.homeScore,
    [`${prefix}_batter_id`]: plate?.currentBatterId ?? null,
    [`${prefix}_pitcher_id`]: plate?.currentPitcherId ?? null,
    [`${prefix}_active_away_pitcher_id`]: state.activePitchers.away,
    [`${prefix}_active_home_pitcher_id`]: state.activePitchers.home,
    [`${prefix}_pa_start_event_id`]: plate?.startEventId ?? null,
    [`${prefix}_pa_start_batter_id`]: plate?.startBatterId ?? null,
    [`${prefix}_pa_start_pitcher_id`]: plate?.startPitcherId ?? null,
    [`${prefix}_pa_walk_responsible_pitcher_id`]: plate?.walkResponsiblePitcherId ?? null,
    [`${prefix}_pa_strikeout_responsible_batter_id`]: plate?.strikeoutResponsibleBatterId ?? null,
    [`${prefix}_pa_actual_pitch_count`]: plate?.actualPitchCount ?? null,
  };
}
function batterLineRow(
  line:
    | StagingGameDocumentV2["officialRecords"]["batters"][number]
    | ReplayResult["batterLines"][number],
): ProjectionRow {
  return {
    player_id: line.playerId,
    side: line.side,
    plate_appearances: line.plateAppearances ?? null,
    at_bats: line.atBats,
    runs: line.runs,
    hits: line.hits,
    doubles: line.doubles ?? null,
    triples: line.triples ?? null,
    home_runs: line.homeRuns,
    runs_batted_in: line.runsBattedIn,
    walks: line.walks,
    intentional_walks: line.intentionalWalks ?? null,
    hit_by_pitch: line.hitByPitch ?? null,
    strikeouts: line.strikeouts,
    sacrifice_bunts: line.sacrificeBunts ?? null,
    sacrifice_flies: line.sacrificeFlies ?? null,
  };
}
function pitcherLineRow(
  line:
    | StagingGameDocumentV2["officialRecords"]["pitchers"][number]
    | ReplayResult["pitcherLines"][number],
  earnedRuns: number | null,
  earnedRunsColumn = "earned_runs",
): ProjectionRow {
  return {
    player_id: line.playerId,
    side: line.side,
    batters_faced: line.battersFaced,
    outs_recorded: line.outsRecorded,
    hits: line.hits,
    runs: line.runs,
    [earnedRunsColumn]: earnedRuns,
    walks: line.walks,
    intentional_walks: line.intentionalWalks ?? null,
    hit_by_pitch: line.hitByPitch,
    strikeouts: line.strikeouts,
    pitches: line.pitches ?? null,
    strikes: line.strikes ?? null,
  };
}
function countsAsAtBat(result: string | null): boolean {
  return (
    result !== null &&
    ![
      "walk",
      "intentional_walk",
      "hit_by_pitch",
      "sacrifice_bunt",
      "sacrifice_fly",
      "interference",
    ].includes(result)
  );
}
function prefixedScalar(
  prefix: string,
  value: string | number | boolean | null | undefined,
): ProjectionRow {
  const scalar = value ?? null;
  return {
    [`${prefix}_type`]: scalar === null ? "null" : typeof scalar,
    [`${prefix}_text`]: typeof scalar === "string" ? scalar : null,
    [`${prefix}_number`]: typeof scalar === "number" ? scalar : null,
    [`${prefix}_boolean`]: typeof scalar === "boolean" ? scalar : null,
  };
}
function observedBase(value: string | boolean | null | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? "*" : "";
  return value;
}
