import type { StagingGameDocumentV2 } from "@kbo/contracts";
import type {
  BaserunnerLine,
  BatterLine,
  CompiledPitchFact,
  CompiledPlay,
  Finding,
  GameState,
  PitcherLine,
  PlateAppearanceSummary,
  ReplayFrame,
  ReplayResult,
} from "@kbo/game-core";
import { PersistenceIntegrityError } from "./errors.js";
import { hydrateEvents } from "./projection-events.js";
import {
  boolean,
  dateText,
  findingCategory,
  findingSeverity,
  group,
  half,
  nullableText,
  number,
  pitchCall,
  pitchMetadataFromRow,
  plateAppearanceTerminationReason,
  plateResult,
  relayEventKind,
  requiredNullableNumber,
  requiredNullableText,
  requiredSingle,
  runnerMovementReason,
  runnerOutcome,
  runnerOutKind,
  side,
  stance,
  teamsFromProjection,
  text,
  trackingNumbersFromRow,
} from "./projection-values.js";
import type { ProjectionRow, ProjectionTables } from "./projection.js";
import type {
  ManifestRow,
  StoredReplayRosterPlayer,
  StoredReplaySource,
} from "./revision-types.js";

export function replaySourceFromProjection(
  manifest: ManifestRow,
  tables: ProjectionTables,
): StoredReplaySource {
  const teams = teamsFromProjection(tables);
  const positions = group(
    tables.game_roster_positions,
    (row) => `${text(row.side)}:${number(row.roster_index)}`,
  );
  const replayRoster = (teamSide: "away" | "home"): readonly StoredReplayRosterPlayer[] =>
    tables.game_roster_snapshots
      .filter((row) => row.side === teamSide)
      .map((row) => ({
        playerId: text(row.player_id),
        name: text(row.player_name),
        battingOrder: row.batting_order === null ? null : number(row.batting_order),
        starter: boolean(row.starter),
        positions: (positions.get(`${teamSide}:${number(row.roster_index)}`) ?? []).map((item) =>
          text(item.position),
        ),
      }));
  const rosters: StoredReplaySource["rosters"] = {
    away: replayRoster("away"),
    home: replayRoster("home"),
  };
  const pitchById = new Map(tables.pitch_facts.map((row) => [text(row.pitch_id), row]));
  const trackingById = new Map(
    tables.tracking_observations.map((row) => [text(row.tracking_id), row]),
  );
  const trackingCandidates: StagingGameDocumentV2["trackingCandidates"] =
    tables.pitch_tracking_links.map((link) => {
      const row = trackingById.get(text(link.tracking_id));
      if (row === undefined) {
        throw new PersistenceIntegrityError("tracking link의 원천 관측을 찾을 수 없습니다.");
      }
      const pitch = pitchById.get(text(link.pitch_id));
      if (pitch === undefined) {
        throw new PersistenceIntegrityError("tracking에 대응하는 pitch fact가 없습니다.");
      }
      return {
        trackingId: text(row.tracking_id),
        source: {
          endpoint: text(row.source_endpoint),
          blockIndex: number(row.source_block_index),
          rowIndex: number(row.source_row_index),
        },
        ...(row.source_pitch_id === null ? {} : { sourcePitchId: text(row.source_pitch_id) }),
        sourcePitchOrdinal:
          row.source_pitch_ordinal === null ? null : number(row.source_pitch_ordinal),
        sequence: number(row.tracking_sequence),
        inning: number(pitch.inning),
        half: half(pitch.half),
        ...(pitch.plate_appearance_event_id === null
          ? {}
          : { plateAppearanceEventId: text(pitch.plate_appearance_event_id) }),
        ...(row.pitcher_id === null ? {} : { pitcherId: text(row.pitcher_id) }),
        ...(row.batter_id === null ? {} : { batterId: text(row.batter_id) }),
        ...(row.observed_at === null ? {} : { observedAt: text(row.observed_at) }),
        ...(row.stance === null ? {} : { stance: stance(row.stance) }),
        ...trackingNumbersFromRow(row),
        resolution: { kind: "linked", pitchEventId: text(link.pitch_id) },
      };
    });
  return {
    gameId: manifest.game_id,
    gameDate: dateText(manifest.game_date),
    status: manifest.game_status,
    teams,
    rosters,
    trackingCandidates,
    relayEvents: hydrateEvents(tables).map((event) => {
      return {
        eventId: event.identity.eventId,
        sequence: event.sequence,
        kind: event.kind,
        relayText: event.relayText ?? null,
        substitution: event.kind === "substitution" ? event.payload : null,
      };
    }),
  };
}

export function replayFromProjection(gameId: string, tables: ProjectionTables): ReplayResult {
  const relayByPlay = group(tables.play_events, (row) => String(number(row.play_sequence)));
  const movementsByPlay = group(tables.runner_movement_facts, (row) =>
    String(number(row.play_sequence)),
  );
  const plateEventsByIndex = group(tables.plate_appearance_events, (row) =>
    String(number(row.plate_appearance_index)),
  );
  const eventsByStart = new Map<
    string,
    readonly { readonly eventId: string; readonly sequence: number }[]
  >();
  for (const row of tables.plate_appearance_facts) {
    eventsByStart.set(
      text(row.start_event_id),
      (plateEventsByIndex.get(String(number(row.plate_appearance_index))) ?? []).map((event) => ({
        eventId: text(event.event_id),
        sequence: number(event.event_sequence),
      })),
    );
  }
  const plays: CompiledPlay[] = tables.play_facts.map((row) => {
    const playSequence = number(row.play_sequence);
    const relayEvents = relayByPlay.get(String(playSequence)) ?? [];
    const firstRelaySequence = Math.min(
      ...relayEvents.map((event) => number(event.event_sequence)),
    );
    const lastRelaySequence = Math.max(...relayEvents.map((event) => number(event.event_sequence)));
    if (!Number.isFinite(firstRelaySequence) || !Number.isFinite(lastRelaySequence)) {
      throw new PersistenceIntegrityError("play에 연결된 원장 event가 없습니다.");
    }
    return {
      playId: text(row.play_id),
      sequence: number(row.source_sequence),
      kind: relayEventKind(row.kind),
      inning: number(row.inning),
      half: half(row.half),
      relayEventIds: relayEvents.map((event) => text(event.event_id)),
      relayTexts: relayEvents.flatMap((event) =>
        event.relay_text === null ? [] : [text(event.relay_text)],
      ),
      before: stateFromRow(row, "before", eventsByStart, firstRelaySequence - 1),
      after: stateFromRow(row, "after", eventsByStart, lastRelaySequence),
      applied: boolean(row.applied),
      movements: (movementsByPlay.get(String(playSequence)) ?? []).map((movement) => ({
        movementId: text(movement.movement_id),
        sourceEventId: movement.source_event_id === null ? null : text(movement.source_event_id),
        runnerId: text(movement.runner_id),
        fromBase: number(movement.from_base),
        toBase: number(movement.to_base),
        outcome: runnerOutcome(movement.outcome),
        ...(movement.out_kind === null
          ? {}
          : {
              outKind: runnerOutKind(movement.out_kind),
            }),
        ...(movement.supersedes_third_out === null
          ? {}
          : { supersedesThirdOut: boolean(movement.supersedes_third_out) }),
        responsiblePitcherId: text(movement.responsible_pitcher_id),
        reason: runnerMovementReason(movement.reason),
        derived: boolean(movement.derived),
        sequence: number(movement.source_sequence),
      })),
    };
  });
  const playByEvent = new Map<string, CompiledPlay>();
  for (const play of plays)
    for (const eventId of play.relayEventIds) playByEvent.set(eventId, play);
  const frames: ReplayFrame[] = tables.relay_event_facts.map((event) => {
    const eventId = text(event.event_id);
    const play = playByEvent.get(eventId);
    return {
      eventId,
      sequence: number(event.event_sequence),
      kind: relayEventKind(event.kind),
      playId: play?.playId ?? null,
      before: play?.before ?? stateFromNearestPlay(plays, number(event.event_sequence)),
      after: play?.after ?? stateFromNearestPlay(plays, number(event.event_sequence)),
      applied: play?.applied ?? false,
    };
  });
  const plateAppearances: PlateAppearanceSummary[] = tables.plate_appearance_facts.map((row) => ({
    startEventId: text(row.start_event_id),
    endEventId: row.end_event_id === null ? null : text(row.end_event_id),
    inning: number(row.inning),
    half: half(row.half),
    startBatterId: text(row.start_batter_id),
    batterId: text(row.batter_id),
    startPitcherId: text(row.start_pitcher_id),
    pitcherId: text(row.pitcher_id),
    result: row.result === null ? null : plateResult(row.result),
    completed: boolean(row.completed),
    terminationReason: plateAppearanceTerminationReason(row.termination_reason),
    actualPitchCount: number(row.actual_pitch_count),
    eventIds:
      plateEventsByIndex
        .get(String(number(row.plate_appearance_index)))
        ?.map((event) => text(event.event_id)) ?? [],
  }));
  const frameByEventId = new Map(frames.map((frame) => [frame.eventId, frame]));
  const eventSequenceById = new Map(
    tables.relay_event_facts.map((event) => [text(event.event_id), number(event.event_sequence)]),
  );
  const pitchFacts: CompiledPitchFact[] = tables.pitch_facts.map((row) => {
    const pitchId = text(row.pitch_id);
    const frame = frameByEventId.get(pitchId);
    if (frame === undefined) throw new PersistenceIntegrityError("pitch frame이 없습니다.");
    const sourceSequence = eventSequenceById.get(pitchId);
    if (sourceSequence === undefined)
      throw new PersistenceIntegrityError("pitch 원장 sequence가 없습니다.");
    return {
      pitchId,
      sequence: sourceSequence,
      inning: number(row.inning),
      half: half(row.half),
      plateAppearanceEventId:
        row.plate_appearance_event_id === null ? null : text(row.plate_appearance_event_id),
      pitchEventNumber: row.pitch_event_number === null ? null : number(row.pitch_event_number),
      actualPitchNumber: row.actual_pitch_number === null ? null : number(row.actual_pitch_number),
      batterId: row.batter_id === null ? null : text(row.batter_id),
      pitcherId: row.pitcher_id === null ? null : text(row.pitcher_id),
      sourcePitchId: row.source_pitch_id === null ? null : text(row.source_pitch_id),
      ...pitchMetadataFromRow(row),
      call: pitchCall(row.pitch_call),
      actual: boolean(row.actual),
      ball: boolean(row.ball),
      calledStrike: boolean(row.called_strike),
      swing: boolean(row.swing),
      whiff: boolean(row.whiff),
      foul: boolean(row.foul),
      inPlay: boolean(row.in_play),
      strike: boolean(row.strike),
      csw: boolean(row.csw),
      before: frame.before,
      after: frame.after,
    };
  });
  return {
    gameId,
    finalState: stateFromRow(
      requiredSingle(tables.game_final_states, "game_final_states"),
      "final",
      eventsByStart,
    ),
    frames,
    plays,
    plateAppearances,
    pitchFacts,
    batterLines: tables.batter_game_facts.map(batterLineFromRow),
    pitcherLines: tables.pitcher_game_facts.map(pitcherLineFromRow),
    baserunnerLines: tables.baserunner_game_facts.map(baserunnerLineFromRow),
    findings: findingsFromProjection(gameId, tables),
  };
}

function stateFromNearestPlay(plays: readonly CompiledPlay[], sequence: number): GameState {
  const previous = [...plays].reverse().find((play) => play.sequence < sequence);
  if (previous !== undefined) return previous.after;
  const next = plays.find((play) => play.sequence > sequence);
  if (next !== undefined) return next.before;
  throw new PersistenceIntegrityError(
    `원장 행 ${String(sequence)}에 대응하는 상태 fact가 없습니다.`,
  );
}

function stateFromRow(
  row: ProjectionRow,
  prefix: string,
  eventsByStart: ReadonlyMap<
    string,
    readonly { readonly eventId: string; readonly sequence: number }[]
  >,
  eventSequenceLimit?: number,
): GameState {
  const startEventId = nullableText(row[`${prefix}_pa_start_event_id`]);
  const occupant = (base: number) => {
    const runnerId = nullableText(row[`${prefix}_base${String(base)}_runner_id`]);
    const pitcherId = nullableText(row[`${prefix}_base${String(base)}_pitcher_id`]);
    if (runnerId === null && pitcherId === null) return null;
    if (runnerId === null || pitcherId === null)
      throw new PersistenceIntegrityError("주자와 책임 투수 fact가 불완전합니다.");
    return { runnerId, responsiblePitcherId: pitcherId };
  };
  const activePlateAppearance =
    startEventId === null
      ? null
      : {
          startEventId,
          startBatterId: requiredNullableText(row[`${prefix}_pa_start_batter_id`], "PA 시작 타자"),
          currentBatterId: requiredNullableText(row[`${prefix}_batter_id`], "PA 현재 타자"),
          startPitcherId: requiredNullableText(
            row[`${prefix}_pa_start_pitcher_id`],
            "PA 시작 투수",
          ),
          currentPitcherId: requiredNullableText(row[`${prefix}_pitcher_id`], "PA 현재 투수"),
          walkResponsiblePitcherId: nullableText(row[`${prefix}_pa_walk_responsible_pitcher_id`]),
          strikeoutResponsibleBatterId: nullableText(
            row[`${prefix}_pa_strikeout_responsible_batter_id`],
          ),
          actualPitchCount: requiredNullableNumber(
            row[`${prefix}_pa_actual_pitch_count`],
            "PA 투구 수",
          ),
          eventIds: (eventsByStart.get(startEventId) ?? [])
            .filter(
              (event) => eventSequenceLimit === undefined || event.sequence <= eventSequenceLimit,
            )
            .map((event) => event.eventId),
        };
  return {
    inning: number(row[`${prefix}_inning`]),
    half: half(row[`${prefix}_half`]),
    halfActive: boolean(row[`${prefix}_half_active`]),
    balls: number(row[`${prefix}_balls`]),
    strikes: number(row[`${prefix}_strikes`]),
    outs: number(row[`${prefix}_outs`]),
    bases: [occupant(1), occupant(2), occupant(3)],
    awayScore: number(row[`${prefix}_away_score`]),
    homeScore: number(row[`${prefix}_home_score`]),
    activePlateAppearance,
    activePitchers: {
      away: nullableText(row[`${prefix}_active_away_pitcher_id`]),
      home: nullableText(row[`${prefix}_active_home_pitcher_id`]),
    },
  };
}

function batterLineFromRow(row: ProjectionRow): BatterLine {
  return {
    playerId: text(row.player_id),
    side: side(row.side),
    plateAppearances: number(row.plate_appearances),
    atBats: number(row.at_bats),
    runs: number(row.runs),
    hits: number(row.hits),
    doubles: number(row.doubles),
    triples: number(row.triples),
    homeRuns: number(row.home_runs),
    runsBattedIn: number(row.runs_batted_in),
    walks: number(row.walks),
    intentionalWalks: number(row.intentional_walks),
    hitByPitch: number(row.hit_by_pitch),
    strikeouts: number(row.strikeouts),
    sacrificeBunts: number(row.sacrifice_bunts),
    sacrificeFlies: number(row.sacrifice_flies),
  };
}

function pitcherLineFromRow(row: ProjectionRow): PitcherLine {
  return {
    playerId: text(row.player_id),
    side: side(row.side),
    battersFaced: number(row.batters_faced),
    outsRecorded: number(row.outs_recorded),
    hits: number(row.hits),
    runs: number(row.runs),
    earnedRuns: null,
    walks: number(row.walks),
    intentionalWalks: number(row.intentional_walks),
    hitByPitch: number(row.hit_by_pitch),
    strikeouts: number(row.strikeouts),
    pitches: number(row.pitches),
    strikes: number(row.strikes),
  };
}

function baserunnerLineFromRow(row: ProjectionRow): BaserunnerLine {
  return {
    playerId: text(row.player_id),
    side: side(row.side),
    advances: number(row.advances),
    extraBasesTaken: number(row.extra_bases_taken),
    runs: number(row.runs),
    stolenBases: number(row.stolen_bases),
    caughtStealing: number(row.caught_stealing),
    pickoffs: number(row.pickoffs),
  };
}

function findingsFromProjection(gameId: string, tables: ProjectionTables): Finding[] {
  const details = group(tables.validation_issue_details, (row) => String(number(row.issue_index)));
  return tables.validation_issues.map((row) => ({
    gameId,
    code: text(row.code),
    category: findingCategory(row.category),
    severity: findingSeverity(row.severity),
    message: text(row.message),
    ...(row.event_id === null ? {} : { eventId: text(row.event_id) }),
    ...(row.event_sequence === null ? {} : { eventSequence: number(row.event_sequence) }),
    ...(row.record_identity === null ? {} : { recordIdentity: text(row.record_identity) }),
    details: (details.get(String(number(row.issue_index))) ?? []).map((detail) => ({
      field: text(detail.field),
      expected: detailScalar(detail, "expected"),
      actual: detailScalar(detail, "actual"),
    })),
  }));
}

function detailScalar(
  row: ProjectionRow,
  prefix: "expected" | "actual",
): string | number | boolean | null {
  const scalarType = text(row[`${prefix}_type`]);
  if (scalarType === "string") return text(row[`${prefix}_text`]);
  if (scalarType === "number") return number(row[`${prefix}_number`]);
  if (scalarType === "boolean") return boolean(row[`${prefix}_boolean`]);
  if (scalarType === "null") return null;
  throw new PersistenceIntegrityError(`알 수 없는 finding detail type: ${scalarType}`);
}
