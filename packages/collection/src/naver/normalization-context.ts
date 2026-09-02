import type { PitchCall, PlateResult, StagingRelayEvent } from "@kbo/contracts";

import { pitchClockWarningAward } from "./lexicon.js";
import type {
  BaseIdentityState,
  CanonicalNaverRow,
  NormalizationPlatePlay,
  ParseContext,
  PlayerIndex,
} from "./model.js";
import { battingOrderForPlayer, battingSide, halfKey, opposite } from "./player-resolver.js";

export function createParseContext(
  players: PlayerIndex,
  startingPitchers: Readonly<Record<"away" | "home", string | null>>,
): ParseContext {
  return {
    players,
    currentBatter: { away: null, home: null },
    currentPitcher: { ...startingPitchers },
    latestPlateResult: {},
    pitchEventIdsByBlock: new Map(),
    observedRunners: {},
    inferredBases: {},
    basesTrusted: {},
    platePlay: {},
    pendingPitchClockAward: {},
  };
}

export function updateNormalizationContext(
  row: CanonicalNaverRow,
  event: StagingRelayEvent,
  context: ParseContext,
): void {
  const batting = battingSide(event.half);
  const fielding = opposite(batting);
  const key = halfKey(event.inning, event.half);
  updateObservedIdentity(row, key, context);
  if (event.kind === "administrative") {
    context.pendingPitchClockAward[key] = pitchClockWarningAward(event.relayText ?? null);
  } else {
    context.pendingPitchClockAward[key] = null;
  }
  if (event.kind === "unresolved") {
    invalidateAffectedContext(event, context);
    return;
  }
  if (event.kind === "half_inning_start") {
    context.latestPlateResult[key] = null;
    context.inferredBases[key] = [null, null, null];
    context.basesTrusted[key] = true;
    context.platePlay[key] = null;
    return;
  }
  if (event.kind === "batter_start") {
    context.currentBatter[batting] = event.payload.batterId;
    context.currentPitcher[fielding] = event.payload.pitcherId;
    context.latestPlateResult[key] = null;
    context.platePlay[key] = null;
    return;
  }
  if (event.kind === "plate_result") {
    context.latestPlateResult[key] = event.identity.eventId;
    if (context.basesTrusted[key] !== false) {
      const destination =
        event.payload.batterDestination ?? defaultBatterDestination(event.payload.result);
      const play: NormalizationPlatePlay = {
        originBases: [...(context.inferredBases[key] ?? [null, null, null])],
        batterPlacement:
          destination === null || destination >= 4
            ? null
            : { batterId: event.payload.batterId, destination },
        movements: [],
      };
      context.platePlay[key] = play;
      context.inferredBases[key] = projectPlatePlay(play);
    }
    return;
  }
  if (event.kind === "runner_advance") {
    if (context.basesTrusted[key] !== false) {
      const play = context.platePlay[key];
      if (
        event.payload.context.kind === "plate_result" &&
        play !== null &&
        play !== undefined &&
        event.payload.context.plateResultEventId === context.latestPlateResult[key]
      ) {
        const updatedPlay: NormalizationPlatePlay = {
          ...play,
          movements: [
            ...play.movements,
            {
              runnerId: event.payload.runnerId,
              fromBase: event.payload.fromBase,
              toBase: event.payload.toBase,
              outcome: event.payload.outcome,
            },
          ],
        };
        context.platePlay[key] = updatedPlay;
        context.inferredBases[key] = projectPlatePlay(updatedPlay);
      } else {
        const bases = [...(context.inferredBases[key] ?? [null, null, null])] as BaseIdentityState;
        if (bases[event.payload.fromBase - 1] === event.payload.runnerId) {
          bases[event.payload.fromBase - 1] = null;
        }
        if (
          event.payload.outcome === "safe" &&
          event.payload.toBase < 4 &&
          bases[event.payload.toBase - 1] === null
        ) {
          bases[event.payload.toBase - 1] = event.payload.runnerId;
        }
        context.inferredBases[key] = bases;
      }
    }
    if (event.payload.context.kind === "independent") {
      context.latestPlateResult[key] = null;
      context.platePlay[key] = null;
    }
    return;
  }
  if (event.kind === "pitch") {
    if (event.payload.batterId !== undefined)
      context.currentBatter[batting] = event.payload.batterId;
    if (event.payload.pitcherId !== undefined) {
      context.currentPitcher[fielding] = event.payload.pitcherId;
    }
    context.latestPlateResult[key] = null;
    context.platePlay[key] = null;
    return;
  }
  if (event.kind === "substitution") {
    if (event.payload.role === "pitcher") {
      context.currentPitcher[event.payload.side] = event.payload.incomingPlayerId;
    }
    if (event.payload.role === "batter") {
      context.currentBatter[event.payload.side] = event.payload.incomingPlayerId;
    }
    if (
      event.payload.role === "runner" &&
      event.payload.outgoingPlayerId !== undefined &&
      context.basesTrusted[key] !== false
    ) {
      const bases = [...(context.inferredBases[key] ?? [null, null, null])] as [
        string | null,
        string | null,
        string | null,
      ];
      const baseIndex = bases.indexOf(event.payload.outgoingPlayerId);
      if (baseIndex >= 0) bases[baseIndex] = event.payload.incomingPlayerId;
      context.inferredBases[key] = bases;
    }
    const battingOrder =
      event.payload.battingOrder ??
      battingOrderForPlayer(
        context.players,
        event.payload.side,
        event.payload.outgoingPlayerId ?? null,
      );
    if (battingOrder !== null) {
      context.players.battingOrder[event.payload.side].set(
        battingOrder,
        event.payload.incomingPlayerId,
      );
    }
    context.latestPlateResult[key] = null;
    context.platePlay[key] = null;
  }
}

export function pendingPitchClockAward(
  row: CanonicalNaverRow,
  context: ParseContext,
): PitchCall | null {
  return context.pendingPitchClockAward[halfKey(row.inning, row.half)] ?? null;
}

function updateObservedIdentity(row: CanonicalNaverRow, key: string, context: ParseContext): void {
  if (!row.observedState.hasBases) return;
  const prior = context.observedRunners[key] ?? [null, null, null];
  context.observedRunners[key] = row.observedState.bases.map((base, index) => {
    if (typeof base === "string" || typeof base === "number") {
      const id = String(base).trim();
      return context.players.sideById.has(id) ? id : (prior[index] ?? null);
    }
    if (base === false || base === null || base === 0 || base === "0" || base === "") return null;
    return prior[index] ?? null;
  }) as [string | null, string | null, string | null];
}

function invalidateAffectedContext(
  event: Extract<StagingRelayEvent, { kind: "unresolved" }>,
  context: ParseContext,
): void {
  const key = halfKey(event.inning, event.half);
  const batting = battingSide(event.half);
  const fielding = opposite(batting);
  switch (event.payload.suspectedKind) {
    case "batter_start":
      context.currentBatter[batting] = null;
      context.latestPlateResult[key] = null;
      context.platePlay[key] = null;
      break;
    case "pitch":
      context.currentBatter[batting] = null;
      context.currentPitcher[fielding] = null;
      context.latestPlateResult[key] = null;
      context.platePlay[key] = null;
      break;
    case "plate_result":
    case "runner_advance":
      context.latestPlateResult[key] = null;
      context.basesTrusted[key] = false;
      context.platePlay[key] = null;
      break;
    case "substitution":
      context.currentBatter[batting] = null;
      context.currentPitcher[fielding] = null;
      context.basesTrusted[key] = false;
      context.latestPlateResult[key] = null;
      context.platePlay[key] = null;
      break;
    default:
      break;
  }
}

function projectPlatePlay(play: NormalizationPlatePlay): BaseIdentityState {
  const bases = [...play.originBases] as BaseIdentityState;
  const movingRunnerIds = new Set(play.movements.map((movement) => movement.runnerId));
  for (let index = 0; index < bases.length; index += 1) {
    const runnerId = bases[index];
    if (runnerId !== null && runnerId !== undefined && movingRunnerIds.has(runnerId)) {
      bases[index] = null;
    }
  }
  for (const movement of play.movements) {
    const currentBaseIndex = bases.indexOf(movement.runnerId);
    if (currentBaseIndex >= 0) bases[currentBaseIndex] = null;
    if (movement.outcome === "safe" && movement.toBase < 4 && bases[movement.toBase - 1] === null) {
      bases[movement.toBase - 1] = movement.runnerId;
    }
  }
  const batter = play.batterPlacement;
  if (
    batter !== null &&
    !movingRunnerIds.has(batter.batterId) &&
    bases[batter.destination - 1] === null
  ) {
    bases[batter.destination - 1] = batter.batterId;
  }
  return bases;
}

function defaultBatterDestination(result: PlateResult): number | null {
  if (
    [
      "single",
      "walk",
      "intentional_walk",
      "hit_by_pitch",
      "fielder_choice",
      "reached_on_error",
      "interference",
    ].includes(result)
  ) {
    return 1;
  }
  if (result === "double") return 2;
  if (result === "triple") return 3;
  if (result === "home_run") return 4;
  return null;
}
