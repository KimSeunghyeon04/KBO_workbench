import type { Half, Side } from "@kbo/contracts";

import {
  decide,
  matched,
  unresolved,
  type DecisionCandidate,
  type ParseDecision,
} from "./decision.js";
import {
  batterActorName,
  battingOrderMention,
  runnerName,
  substitutionSegments,
} from "./lexicon.js";
import type { CanonicalNaverRow, ParseContext, PlayerIndex, RelayRosterPlayer } from "./model.js";
import { normalizedName } from "./source-values.js";

export function createPlayerIndex(players: readonly RelayRosterPlayer[]): PlayerIndex {
  const sideById = new Map<string, Side>();
  const nameById = new Map<string, string>();
  const idsByNameAndSide = new Map<string, string[]>();
  const battingOrder: Record<Side, Map<number, string>> = { away: new Map(), home: new Map() };
  for (const player of players) {
    sideById.set(player.playerId, player.side);
    nameById.set(player.playerId, normalizedName(player.name));
    const key = nameKey(player.side, player.name);
    const ids = idsByNameAndSide.get(key) ?? [];
    ids.push(player.playerId);
    idsByNameAndSide.set(key, ids);
    if (player.starter && player.battingOrder !== undefined) {
      battingOrder[player.side].set(player.battingOrder, player.playerId);
    }
  }
  return { sideById, nameById, idsByNameAndSide, battingOrder };
}

export function resolveBatter(
  row: CanonicalNaverRow,
  context: ParseContext,
): ParseDecision<string> {
  const side = battingSide(row.half);
  const invalid = firstInvalidExplicitIdentity(
    [
      [row.batterId, "row.batter_id"],
      [row.observedState.batterId, "currentGameState.batter"],
    ],
    side,
    context.players,
  );
  if (invalid !== null) return invalid;
  const candidates: DecisionCandidate<string>[] = [];
  addIdentityCandidate(candidates, row.batterId, "batter.structured", 600, "structured");
  addIdentityCandidate(
    candidates,
    row.observedState.batterId,
    "batter.source_state",
    500,
    "source_state",
  );
  const actor = batterActorName(row.relayText);
  if (actor !== null)
    addNameCandidates(candidates, actor, side, context.players, "batter.actor", 400);
  const order = battingOrderMention(row.relayText);
  if (order !== null) {
    addIdentityCandidate(
      candidates,
      context.players.battingOrder[side].get(order) ?? null,
      "batter.batting_order",
      350,
      "roster",
    );
  }
  addMentionCandidates(candidates, row.relayText, side, context.players, "batter.roster_text", 300);
  addIdentityCandidate(
    candidates,
    context.currentBatter[side],
    "batter.active_context",
    100,
    "context",
  );
  return decide(candidates, "batter.unresolved", "타자를 유일하게 식별할 수 없습니다.");
}

export function resolvePitcher(
  row: CanonicalNaverRow,
  context: ParseContext,
): ParseDecision<string> {
  const side = opposite(battingSide(row.half));
  const invalid = firstInvalidExplicitIdentity(
    [
      [row.pitcherId, "row.pitcher_id"],
      [row.observedState.pitcherId, "currentGameState.pitcher"],
    ],
    side,
    context.players,
  );
  if (invalid !== null) return invalid;
  const candidates: DecisionCandidate<string>[] = [];
  addIdentityCandidate(candidates, row.pitcherId, "pitcher.structured", 600, "structured");
  addIdentityCandidate(
    candidates,
    row.observedState.pitcherId,
    "pitcher.source_state",
    500,
    "source_state",
  );
  addIdentityCandidate(
    candidates,
    context.currentPitcher[side],
    "pitcher.active_context",
    100,
    "context",
  );
  return decide(candidates, "pitcher.unresolved", "투수를 유일하게 식별할 수 없습니다.");
}

export function resolveRunner(
  row: CanonicalNaverRow,
  fromBase: number,
  toBase: number,
  outcome: "safe" | "out" | "scored",
  context: ParseContext,
): ParseDecision<string> {
  const side = battingSide(row.half);
  const invalid = firstInvalidExplicitIdentity(
    [[row.runnerId, "row.runner_id"]],
    side,
    context.players,
  );
  if (invalid !== null) return invalid;
  const key = halfKey(row.inning, row.half);
  // Naver's currentGameState describes the state after the whole play, not the
  // state before this individual runner row. The player at fromBase can
  // therefore be a trailing runner that has already advanced into the vacated
  // base. A safe runner's destination is the only base in the current snapshot
  // that directly identifies that row's runner.
  const sourceDestination =
    outcome === "safe" && toBase < 4
      ? sourceBasePlayer(row.observedState.bases[toBase - 1], side, context.players)
      : null;
  const observedBase = context.observedRunners[key]?.[fromBase - 1] ?? null;
  const inferredBase = context.basesTrusted[key]
    ? (context.inferredBases[key]?.[fromBase - 1] ?? null)
    : null;
  const playOriginBase = context.basesTrusted[key]
    ? (context.platePlay[key]?.originBases[fromBase - 1] ?? null)
    : null;
  const name = runnerName(row.relayText);
  const matchingIds =
    name === null ? null : (context.players.idsByNameAndSide.get(nameKey(side, name)) ?? []);
  if (
    matchingIds !== null &&
    (matchingIds.length === 0 || (row.runnerId !== null && !matchingIds.includes(row.runnerId)))
  ) {
    return {
      status: "unresolved",
      ruleId: "runner.explicit_name_conflict",
      reason: "명시된 주자 이름을 선수 ID와 일치시킬 수 없습니다.",
      evidence: [],
    };
  }
  const candidates: DecisionCandidate<string>[] = [];
  addIdentityCandidate(candidates, row.runnerId, "runner.structured", 700, "structured");
  // 플레이 전체의 최종 관찰은 이 행에서 명시한 주자와 일치할 때만 식별 근거다.
  const applicable = (id: string | null): string | null =>
    id !== null && (matchingIds === null || matchingIds.includes(id)) ? id : null;
  addIdentityCandidate(
    candidates,
    applicable(sourceDestination),
    "runner.source_state.destination",
    650,
    "source_state",
  );
  if (name !== null)
    addNameCandidates(
      candidates,
      name,
      side,
      context.players,
      "runner.name",
      matchingIds?.length === 1 ? 600 : 400,
    );
  addIdentityCandidate(
    candidates,
    applicable(observedBase),
    "runner.source_state.previous",
    550,
    "source_state",
  );
  addIdentityCandidate(
    candidates,
    applicable(playOriginBase),
    "runner.plate_play_origin",
    575,
    "context",
  );
  const play = context.basesTrusted[key] ? context.platePlay[key] : null;
  const placement = play?.batterPlacement;
  if (placement !== undefined && placement !== null) {
    const lastMove = play?.movements.filter((move) => move.runnerId === placement.batterId).at(-1);
    const currentBase =
      lastMove === undefined
        ? placement.destination
        : lastMove.outcome === "safe"
          ? lastMove.toBase
          : null;
    if (currentBase === fromBase)
      addIdentityCandidate(
        candidates,
        applicable(placement.batterId),
        "runner.plate_play_batter",
        575,
        "context",
      );
  }
  addIdentityCandidate(
    candidates,
    applicable(inferredBase),
    "runner.ledger_context",
    500,
    "context",
  );
  return decide(candidates, "runner.identity_unresolved", "주자를 유일하게 식별할 수 없습니다.");
}

export function resolveSubstitutionPlayers(
  row: CanonicalNaverRow,
  side: Side,
  role: "batter" | "runner" | "pitcher" | "fielder",
  context: ParseContext,
): {
  readonly incoming: ParseDecision<string>;
  readonly outgoing: ParseDecision<string> | { readonly status: "not_applicable" };
} {
  const explicitIncoming = validateOptionalIdentity(
    row.incomingPlayerId,
    side,
    context.players,
    "incoming_player_id",
  );
  if (explicitIncoming.status === "unresolved") {
    return { incoming: explicitIncoming, outgoing: { status: "not_applicable" } };
  }
  const explicitOutgoing = validateOptionalIdentity(
    row.outgoingPlayerId,
    side,
    context.players,
    "outgoing_player_id",
  );
  if (explicitOutgoing.status === "unresolved") {
    return { incoming: explicitOutgoing, outgoing: explicitOutgoing };
  }
  const segments = substitutionSegments(row.relayText);
  const incomingCandidates: DecisionCandidate<string>[] = [];
  const outgoingCandidates: DecisionCandidate<string>[] = [];
  if (explicitIncoming.status === "matched") {
    addIdentityCandidate(
      incomingCandidates,
      explicitIncoming.value,
      "substitution.incoming.structured",
      700,
      "structured",
    );
  }
  if (explicitOutgoing.status === "matched") {
    addIdentityCandidate(
      outgoingCandidates,
      explicitOutgoing.value,
      "substitution.outgoing.structured",
      700,
      "structured",
    );
  }
  const activeOutgoingPitcher =
    role === "pitcher"
      ? context.currentPitcher[side]
      : role === "batter"
        ? context.currentBatter[side]
        : null;
  if (
    activeOutgoingPitcher !== null &&
    playerMentionedInSegment(
      activeOutgoingPitcher,
      segments?.outgoing ?? row.relayText ?? "",
      context.players,
    )
  ) {
    addIdentityCandidate(
      outgoingCandidates,
      activeOutgoingPitcher,
      role === "pitcher"
        ? "substitution.outgoing.active_pitcher"
        : "substitution.outgoing.active_batter",
      550,
      "context",
    );
  }
  const statePlayerId =
    role === "pitcher"
      ? row.observedState.pitcherId
      : role === "batter"
        ? row.observedState.batterId
        : null;
  if (
    statePlayerId !== null &&
    context.players.sideById.get(statePlayerId) === side &&
    playerMentionedInSegment(
      statePlayerId,
      segments?.incoming ?? row.relayText ?? "",
      context.players,
    )
  ) {
    addIdentityCandidate(
      incomingCandidates,
      statePlayerId,
      "substitution.incoming.source_state",
      600,
      "source_state",
    );
  }
  if (segments !== null) {
    addSegmentCandidates(
      incomingCandidates,
      segments.incoming,
      side,
      context.players,
      "substitution.incoming.segment",
      500,
    );
    addSegmentCandidates(
      outgoingCandidates,
      segments.outgoing,
      side,
      context.players,
      "substitution.outgoing.segment",
      500,
    );
  } else {
    const mentioned = mentionedPlayerIds(row.relayText, side, context.players);
    const incoming = mentioned.at(-1) ?? null;
    const outgoing = mentioned[0] ?? null;
    addIdentityCandidate(
      incomingCandidates,
      incoming,
      "substitution.incoming.roster_text",
      400,
      "roster",
    );
    addIdentityCandidate(
      outgoingCandidates,
      outgoing,
      "substitution.outgoing.roster_text",
      400,
      "roster",
    );
  }
  return {
    incoming: decide(
      incomingCandidates,
      "substitution.incoming_unresolved",
      "교체로 들어오는 선수를 유일하게 식별할 수 없습니다.",
    ),
    outgoing:
      outgoingCandidates.length === 0
        ? { status: "not_applicable" }
        : decide(
            outgoingCandidates,
            "substitution.outgoing_unresolved",
            "교체로 나가는 선수를 유일하게 식별할 수 없습니다.",
          ),
  };
}

export function battingOrderForPlayer(
  players: PlayerIndex,
  side: Side,
  playerId: string | null,
): number | null {
  if (playerId === null) return null;
  for (const [order, activeId] of players.battingOrder[side]) {
    if (activeId === playerId) return order;
  }
  return null;
}

export function battingSide(half: Half): Side {
  return half === "top" ? "away" : "home";
}

export function opposite(side: Side): Side {
  return side === "away" ? "home" : "away";
}

export function halfKey(inning: number, half: Half): string {
  return `${String(inning)}:${half}`;
}

function firstInvalidExplicitIdentity(
  identities: readonly (readonly [string | null, string])[],
  expectedSide: Side,
  players: PlayerIndex,
): ParseDecision<never> | null {
  for (const [playerId, source] of identities) {
    if (playerId === null) continue;
    const actualSide = players.sideById.get(playerId);
    if (actualSide === undefined) {
      return unresolved(
        "entity.not_in_roster",
        `${source}의 선수 ${playerId}가 roster에 없습니다.`,
        [
          {
            source: source.includes("currentGameState") ? "source_state" : "structured",
            detail: playerId,
          },
        ],
      );
    }
    if (actualSide !== expectedSide) {
      return unresolved(
        "entity.wrong_team",
        `${source}의 선수 ${playerId}가 예상 팀 ${expectedSide}에 속하지 않습니다.`,
        [
          {
            source: source.includes("currentGameState") ? "source_state" : "structured",
            detail: playerId,
          },
        ],
      );
    }
  }
  return null;
}

function validateOptionalIdentity(
  playerId: string | null,
  expectedSide: Side,
  players: PlayerIndex,
  label: string,
): ParseDecision<string> | { readonly status: "not_applicable" } {
  if (playerId === null) return { status: "not_applicable" };
  const invalid = firstInvalidExplicitIdentity([[playerId, label]], expectedSide, players);
  return (
    invalid ??
    matched(playerId, `${label}.structured`, [{ source: "structured", detail: playerId }])
  );
}

function addIdentityCandidate(
  candidates: DecisionCandidate<string>[],
  playerId: string | null,
  ruleId: string,
  strength: number,
  source: "structured" | "source_state" | "roster" | "context",
): void {
  if (playerId === null) return;
  candidates.push({ value: playerId, ruleId, strength, evidence: [{ source, detail: playerId }] });
}

function addNameCandidates(
  candidates: DecisionCandidate<string>[],
  name: string,
  side: Side,
  players: PlayerIndex,
  ruleId: string,
  strength: number,
): void {
  for (const playerId of players.idsByNameAndSide.get(nameKey(side, name)) ?? []) {
    candidates.push({
      value: playerId,
      ruleId,
      strength,
      evidence: [{ source: "roster", detail: `${normalizedName(name)} (${playerId})` }],
    });
  }
}

function addMentionCandidates(
  candidates: DecisionCandidate<string>[],
  text: string | null,
  side: Side,
  players: PlayerIndex,
  ruleId: string,
  strength: number,
): void {
  for (const playerId of mentionedPlayerIds(text, side, players)) {
    addIdentityCandidate(candidates, playerId, ruleId, strength, "roster");
  }
}

function addSegmentCandidates(
  candidates: DecisionCandidate<string>[],
  segment: string,
  side: Side,
  players: PlayerIndex,
  ruleId: string,
  strength: number,
): void {
  const normalizedSegment = normalizedName(segment);
  const matches = [...players.nameById]
    .filter(
      ([playerId, name]) =>
        players.sideById.get(playerId) === side &&
        (normalizedSegment === name || normalizedSegment.endsWith(` ${name}`)),
    )
    .sort((left, right) => right[1].length - left[1].length);
  const longest = matches[0]?.[1];
  for (const [playerId, name] of matches.filter(
    (candidate) => candidate[1].length === longest?.length,
  )) {
    candidates.push({
      value: playerId,
      ruleId,
      strength,
      specificity: name.length,
      evidence: [{ source: "roster", detail: `${normalizedSegment} -> ${name} (${playerId})` }],
    });
  }
}

function mentionedPlayerIds(textValue: string | null, side: Side, players: PlayerIndex): string[] {
  const text = normalizedName(textValue ?? "");
  return [...players.nameById]
    .filter(([playerId, name]) => players.sideById.get(playerId) === side && text.includes(name))
    .sort((left, right) => text.indexOf(left[1]) - text.indexOf(right[1]))
    .map(([playerId]) => playerId);
}

function playerMentionedInSegment(
  playerId: string,
  segment: string,
  players: PlayerIndex,
): boolean {
  const name = players.nameById.get(playerId);
  return name !== undefined && normalizedName(segment).includes(name);
}

function sourceBasePlayer(value: unknown, side: Side, players: PlayerIndex): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return players.sideById.get(id) === side ? id : null;
}

function nameKey(side: Side, name: string): string {
  return `${side}\0${normalizedName(name)}`;
}
