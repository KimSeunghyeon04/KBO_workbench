import type { StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";

const pitchLabels: Readonly<Record<string, string>> = {
  ball: "볼",
  called_strike: "스트라이크",
  swinging_strike: "헛스윙",
  foul: "파울",
  foul_bunt: "번트 파울",
  foul_tip: "파울팁",
  in_play: "타격",
  hit_by_pitch: "몸에 맞는 공",
  automatic_ball: "자동 볼",
  automatic_strike: "자동 스트라이크",
  no_pitch: "투구 무효",
};

const resultLabels: Readonly<Record<string, string>> = {
  single: "안타",
  double: "2루타",
  triple: "3루타",
  home_run: "홈런",
  walk: "볼넷",
  intentional_walk: "고의4구",
  hit_by_pitch: "몸에 맞는 공",
  strikeout: "삼진",
  field_out: "아웃",
  sacrifice_bunt: "희생번트",
  sacrifice_fly: "희생플라이",
  fielder_choice: "야수선택으로 출루",
  reached_on_error: "실책으로 출루",
  interference: "방해로 출루",
  double_play: "병살타",
  triple_play: "삼중살",
  other: "기타 결과",
};

const fieldOutLabels: Readonly<Record<string, string>> = {
  ground_ball: "땅볼 아웃",
  fly_ball: "플라이 아웃",
  line_drive: "라인드라이브 아웃",
  popup: "내야 플라이 아웃",
};

const runnerReasonLabels: Readonly<Record<string, string>> = {
  stolen_base: "도루로",
  caught_stealing: "도루 실패로",
  pickoff: "견제로",
  wild_pitch: "폭투로",
  passed_ball: "포일로",
  balk: "보크로",
  defensive_indifference: "다른주자수비하는 사이",
  error: "실책으로",
  appeal: "어필 플레이로",
};

export interface RelayTextOptions {
  readonly playerName?: ((playerId: string) => string | undefined) | undefined;
  readonly battingOrder?: ((playerId: string) => number | undefined) | undefined;
  readonly pitchOrdinal?: number | undefined;
}

export function suggestedRelayText(
  event: StagingRelayEvent,
  options: RelayTextOptions = {},
): string {
  const player = (playerId: string): string => options.playerName?.(playerId) ?? "선수 미확정";
  const half = `${String(event.inning)}회${event.half === "top" ? "초" : "말"}`;
  if (event.kind === "half_inning_start") return `${half} 시작`;
  if (event.kind === "batter_start") {
    const name = player(event.payload.batterId);
    const order = options.battingOrder?.(event.payload.batterId);
    return order === undefined ? `${name} 타석` : `${String(order)}번타자 ${name}`;
  }
  if (event.kind === "pitch") {
    const label = pitchLabels[event.payload.call] ?? event.payload.call;
    return options.pitchOrdinal === undefined
      ? label
      : `${String(options.pitchOrdinal)}구 ${label}`;
  }
  if (event.kind === "plate_result") {
    const result =
      event.payload.result === "field_out" && event.payload.battedBallType !== undefined
        ? (fieldOutLabels[event.payload.battedBallType] ?? "아웃")
        : (resultLabels[event.payload.result] ?? event.payload.result);
    return `${player(event.payload.batterId)} : ${result}`;
  }
  if (event.kind === "runner_advance") {
    const from = baseLabel(event.payload.fromBase);
    const to = baseLabel(event.payload.toBase);
    if (event.payload.outcome === "scored")
      return `${from}주자 ${player(event.payload.runnerId)} : 홈인`;
    if (event.payload.outcome === "out")
      return `${from}주자 ${player(event.payload.runnerId)} : ${to}에서 아웃`;
    const reason =
      event.payload.context.kind === "independent" && event.payload.context.reason !== "other"
        ? `${runnerReasonLabels[event.payload.context.reason] ?? ""} `
        : "";
    return `${from}주자 ${player(event.payload.runnerId)} : ${reason}${to}까지 진루`;
  }
  if (event.kind === "substitution") {
    const incoming = substitutionPlayerLabel(
      event.payload.role,
      event.payload.incomingPlayerId,
      event.payload.battingOrder,
      event.payload.fieldPosition,
      player,
      true,
    );
    return event.payload.outgoingPlayerId === undefined
      ? `${incoming} 교체 출전`
      : `${substitutionPlayerLabel(
          event.payload.role,
          event.payload.outgoingPlayerId,
          event.payload.battingOrder,
          event.payload.fieldPosition,
          player,
          false,
        )} : ${incoming} (으)로 교체`;
  }
  if (event.kind === "review") return reviewLabel(event.payload.decision);
  if (event.kind === "administrative") return administrativeLabel(event.payload.code);
  return event.relayText ?? "해석하지 못한 중계 행";
}

export function pitchOrdinalAt(
  events: readonly StagingRelayEvent[],
  targetIndex: number,
  location: Pick<StagingRelayEvent, "inning" | "half">,
): number | undefined {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > events.length)
    return undefined;
  let precedingPitches = 0;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.inning !== location.inning || event.half !== location.half) return undefined;
    if (event.kind === "batter_start") return precedingPitches + 1;
    if (event.kind === "plate_result" || event.kind === "half_inning_start") return undefined;
    if (event.kind === "pitch") precedingPitches += 1;
  }
  return undefined;
}

export function effectiveRelayText(
  event: StagingRelayEvent,
  options: RelayTextOptions = {},
): string {
  return event.relayText ?? suggestedRelayText(event, options);
}

export function relayTextByEvent(document: StagingGameDocumentV2): ReadonlyMap<string, string> {
  const players = [...document.rosters.away.players, ...document.rosters.home.players];
  const names = new Map(players.map((item) => [item.playerId, item.name]));
  const battingOrders = new Map(
    players.flatMap((item) =>
      item.battingOrder === undefined ? [] : [[item.playerId, item.battingOrder] as const],
    ),
  );
  return new Map(
    document.events.map((event, index) => {
      const pitchOrdinal =
        event.kind === "pitch" ? pitchOrdinalAt(document.events, index, event) : undefined;
      return [
        event.identity.eventId,
        effectiveRelayText(event, {
          playerName: (playerId) => names.get(playerId),
          battingOrder: (playerId) => battingOrders.get(playerId),
          ...(pitchOrdinal === undefined ? {} : { pitchOrdinal }),
        }),
      ];
    }),
  );
}

function substitutionPlayerLabel(
  role: Extract<StagingRelayEvent, { kind: "substitution" }>["payload"]["role"],
  playerId: string,
  battingOrder: number | undefined,
  fieldPosition: string | undefined,
  player: (playerId: string) => string,
  incoming: boolean,
): string {
  const name = player(playerId);
  if (role === "pitcher") return `투수 ${name}`;
  if (role === "runner") return `대주자 ${name}`;
  if (role === "fielder") return `${fieldPosition ?? "야수"} ${name}`;
  if (incoming) return `대타 ${name}`;
  return battingOrder === undefined ? name : `${String(battingOrder)}번타자 ${name}`;
}

function reviewLabel(
  decision: Extract<StagingRelayEvent, { kind: "review" }>["payload"]["decision"],
): string {
  if (decision === "requested") return "비디오 판독 요청";
  if (decision === "upheld") return "비디오 판독 결과 : 원심 유지";
  if (decision === "overturned") return "비디오 판독 결과 : 판정 번복";
  if (decision === "inconclusive") return "비디오 판독 결과 : 판정 불가";
  return "비디오 판독";
}

function baseLabel(base: number): string {
  if (base === 0) return "타자";
  if (base === 4) return "홈";
  return `${String(base)}루`;
}

function administrativeLabel(code: string): string {
  if (code === "mound_visit") return "마운드 방문";
  if (code === "break") return "경기 중단";
  if (code === "footer") return "중계 종료 안내";
  if (code === "announcement") return "경기 안내";
  return "기타 중계 안내";
}
