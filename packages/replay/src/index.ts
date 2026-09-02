import { createHash } from "node:crypto";

import {
  canonicalStringify,
  compareCanonicalStrings,
  type ReplayFielder,
  type ReplayFrame,
  type ReplayManifest,
  type ReplayPlayer,
  type ReplayPlateAppearanceState,
  type ReplayState,
  type ReplayTrackingCandidate,
  type Side,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import type { GameState, ReplayResult } from "@kbo/game-core";

export const REPLAY_MODULE_VERSION = "2.0.0";
export const DEFAULT_REPLAY_CHUNK_SIZE = 250;

export interface ReplaySourceRosterPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly battingOrder: number | null;
  readonly starter: boolean;
  readonly positions: readonly string[];
}
export interface ReplaySourceRelayEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: StagingRelayEvent["kind"];
  readonly relayText: string | null;
  readonly substitution: Extract<StagingRelayEvent, { kind: "substitution" }>["payload"] | null;
}
export interface ReplaySourceData {
  readonly gameId: string;
  readonly gameDate: string;
  readonly status: StagingGameDocumentV2["metadata"]["status"];
  readonly teams: StagingGameDocumentV2["teams"];
  readonly rosters: Readonly<Record<Side, readonly ReplaySourceRosterPlayer[]>>;
  readonly relayEvents: readonly ReplaySourceRelayEvent[];
  readonly trackingCandidates: StagingGameDocumentV2["trackingCandidates"];
}
export interface ReplayBundleInput {
  readonly source: ReplaySourceData;
  readonly revision: number;
  readonly documentHash: string;
  readonly projectionHash: string;
  readonly compiled: ReplayResult;
}
export interface ReplayBundle {
  readonly manifest: ReplayManifest;
  readonly frames: readonly ReplayFrame[];
}
interface ActiveFielder {
  readonly side: Side;
  readonly playerId: string;
  readonly battingOrder: number | null;
  readonly positions: readonly string[];
}

/** DB typed fact를 replay 응답으로 변환하며 staging 원장이나 compiler에는 접근하지 않는다. */
export function buildReplayBundle(input: ReplayBundleInput): ReplayBundle {
  const players = playerDirectory(input.source);
  const tracking = buildTracking(input.source, players);
  const active = initialFielders(input.source);
  const events = new Map(input.source.relayEvents.map((event) => [event.eventId, event]));
  const frames = input.compiled.plays.map((play, index) => {
    const relayEvents = play.relayEventIds.map((eventId) => requiredEvent(events, eventId));
    const substitution = relayEvents.find((event) => event.substitution !== null)?.substitution;
    if (play.applied && substitution !== undefined && substitution !== null) {
      applySubstitution(active, substitution, play.before, input.source);
    }
    const after = replayState(play.after, players);
    return {
      gameId: input.source.gameId,
      revision: input.revision,
      playId: play.playId,
      playNumber: index + 1,
      sequence: play.sequence,
      kind: play.kind,
      inning: play.inning,
      half: play.half,
      applied: play.applied,
      relayEvents: relayEvents.map((event) => ({
        eventId: event.eventId,
        sequence: event.sequence,
        kind: event.kind,
        relayText: event.relayText,
      })),
      before: replayState(play.before, players),
      after,
      movements: play.movements.map((movement) => ({
        movementId: movement.movementId,
        sourceEventId: movement.sourceEventId,
        runner: player(players, movement.runnerId),
        fromBase: movement.fromBase,
        toBase: movement.toBase,
        outcome: movement.outcome,
        outKind: movement.outKind ?? null,
        supersedesThirdOut: movement.supersedesThirdOut ?? null,
        responsiblePitcher: player(players, movement.responsiblePitcherId),
        derived: movement.derived,
        sequence: movement.sequence,
      })),
      fielders: currentFielders(active, play.half, players),
      plateAppearance: after.plateAppearance,
      tracking: relayEvents.flatMap((event) => tracking.byEvent.get(event.eventId) ?? []),
    } satisfies ReplayFrame;
  });
  const frameHash = createHash("sha256").update(canonicalStringify(frames), "utf8").digest("hex");
  return {
    frames,
    manifest: {
      schemaVersion: 2,
      gameId: input.source.gameId,
      revision: input.revision,
      documentHash: input.documentHash,
      projectionHash: input.projectionHash,
      frameHash,
      frameCount: frames.length,
      trackingCount: input.source.trackingCandidates.length,
      gameDate: input.source.gameDate,
      status: input.source.status,
      teams: input.source.teams,
      finalState: replayState(input.compiled.finalState, players),
      unlinkedTracking: tracking.unlinked,
      blockingCount: input.compiled.findings.filter((finding) => finding.severity === "blocking")
        .length,
      warningCount: input.compiled.findings.filter((finding) => finding.severity === "warning")
        .length,
      defaultChunkSize: DEFAULT_REPLAY_CHUNK_SIZE,
    },
  };
}

function replayState(state: GameState, players: ReadonlyMap<string, ReplayPlayer>): ReplayState {
  const pa = activePlateAppearance(state, players);
  return {
    inning: state.inning,
    half: state.half,
    halfActive: state.halfActive,
    balls: state.balls,
    strikes: state.strikes,
    outs: state.outs,
    bases: state.bases.map((base) =>
      base === null
        ? null
        : {
            runner: player(players, base.runnerId),
            responsiblePitcher: player(players, base.responsiblePitcherId),
          },
    ) as ReplayState["bases"],
    awayScore: state.awayScore,
    homeScore: state.homeScore,
    batter: pa?.batter ?? null,
    pitcher: pa?.pitcher ?? playerOrNull(players, state.activePitchers[fieldingSide(state.half)]),
    activePitchers: {
      away: playerOrNull(players, state.activePitchers.away),
      home: playerOrNull(players, state.activePitchers.home),
    },
    plateAppearance: pa,
  };
}
function activePlateAppearance(
  state: GameState,
  players: ReadonlyMap<string, ReplayPlayer>,
): ReplayPlateAppearanceState | null {
  const pa = state.activePlateAppearance;
  return pa === null
    ? null
    : {
        startEventId: pa.startEventId,
        batter: player(players, pa.currentBatterId),
        pitcher: player(players, pa.currentPitcherId),
        actualPitchCount: pa.actualPitchCount,
      };
}
function buildTracking(
  source: ReplaySourceData,
  players: ReadonlyMap<string, ReplayPlayer>,
): {
  readonly byEvent: ReadonlyMap<string, ReplayTrackingCandidate[]>;
  readonly unlinked: ReplayTrackingCandidate[];
} {
  const eventIds = new Set(source.relayEvents.map((event) => event.eventId));
  const byEvent = new Map<string, ReplayTrackingCandidate[]>();
  const unlinked: ReplayTrackingCandidate[] = [];
  for (const observation of source.trackingCandidates) {
    if (observation.resolution.kind !== "linked") {
      continue;
    }
    const item: ReplayTrackingCandidate = {
      trackingId: observation.trackingId,
      sourcePitchId: observation.sourcePitchId ?? null,
      pitchEventId: observation.resolution.pitchEventId,
      sourcePitchOrdinal: observation.sourcePitchOrdinal,
      sequence: observation.sequence,
      pitcher: playerOrNull(players, observation.pitcherId ?? null),
      batter: playerOrNull(players, observation.batterId ?? null),
      observedAt: observation.observedAt ?? null,
      stance: observation.stance ?? null,
      x0: observation.x0 ?? null,
      y0: observation.y0 ?? null,
      z0: observation.z0 ?? null,
      vx0: observation.vx0 ?? null,
      vy0: observation.vy0 ?? null,
      vz0: observation.vz0 ?? null,
      ax: observation.ax ?? null,
      ay: observation.ay ?? null,
      az: observation.az ?? null,
      crossPlateX: observation.crossPlateX ?? null,
      crossPlateY: observation.crossPlateY ?? null,
      topSz: observation.topSz ?? null,
      bottomSz: observation.bottomSz ?? null,
    };
    if (!eventIds.has(observation.resolution.pitchEventId)) {
      unlinked.push(item);
    } else {
      const list = byEvent.get(observation.resolution.pitchEventId) ?? [];
      list.push(item);
      byEvent.set(observation.resolution.pitchEventId, list);
    }
  }
  return { byEvent, unlinked };
}
function playerDirectory(source: ReplaySourceData): ReadonlyMap<string, ReplayPlayer> {
  return new Map(
    [...source.rosters.away, ...source.rosters.home].map((item) => [
      item.playerId,
      { playerId: item.playerId, name: item.name },
    ]),
  );
}
function player(players: ReadonlyMap<string, ReplayPlayer>, id: string): ReplayPlayer {
  return players.get(id) ?? { playerId: id, name: id };
}
function playerOrNull(
  players: ReadonlyMap<string, ReplayPlayer>,
  id: string | null,
): ReplayPlayer | null {
  return id === null ? null : player(players, id);
}
function initialFielders(source: ReplaySourceData): Map<string, ActiveFielder> {
  const result = new Map<string, ActiveFielder>();
  for (const side of ["away", "home"] as const) {
    for (const item of source.rosters[side]) {
      if (item.starter)
        result.set(item.playerId, {
          side,
          playerId: item.playerId,
          battingOrder: item.battingOrder,
          positions: [...item.positions],
        });
    }
  }
  return result;
}
function applySubstitution(
  active: Map<string, ActiveFielder>,
  substitution: Extract<StagingRelayEvent, { kind: "substitution" }>["payload"],
  before: GameState,
  source: ReplaySourceData,
): void {
  const outgoing =
    substitution.outgoingPlayerId ??
    (substitution.role === "pitcher" ? before.activePitchers[substitution.side] : null);
  if (outgoing !== null) active.delete(outgoing);
  if (
    substitution.role !== "pitcher" &&
    substitution.role !== "fielder" &&
    substitution.fieldPosition === undefined
  )
    return;
  const roster = source.rosters[substitution.side].find(
    (item) => item.playerId === substitution.incomingPlayerId,
  );
  active.set(substitution.incomingPlayerId, {
    side: substitution.side,
    playerId: substitution.incomingPlayerId,
    battingOrder: substitution.battingOrder ?? roster?.battingOrder ?? null,
    positions:
      substitution.fieldPosition === undefined
        ? [...(roster?.positions ?? [])]
        : [substitution.fieldPosition],
  });
}
function currentFielders(
  active: ReadonlyMap<string, ActiveFielder>,
  half: "top" | "bottom",
  players: ReadonlyMap<string, ReplayPlayer>,
): ReplayFielder[] {
  const side = fieldingSide(half);
  return [...active.values()]
    .filter((item) => item.side === side)
    .sort(
      (left, right) =>
        (left.battingOrder ?? 99) - (right.battingOrder ?? 99) ||
        compareCanonicalStrings(left.playerId, right.playerId),
    )
    .map((item) => ({
      side: item.side,
      player: player(players, item.playerId),
      battingOrder: item.battingOrder,
      positions: [...item.positions],
    }));
}
function requiredEvent(
  events: ReadonlyMap<string, ReplaySourceRelayEvent>,
  eventId: string,
): ReplaySourceRelayEvent {
  const event = events.get(eventId);
  if (event === undefined)
    throw new Error(`compiler play의 원장 행을 찾을 수 없습니다: ${eventId}`);
  return event;
}
function fieldingSide(half: "top" | "bottom"): Side {
  return half === "top" ? "home" : "away";
}
