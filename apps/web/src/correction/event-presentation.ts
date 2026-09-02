import {
  compareCanonicalStrings,
  type CatalogAuthority,
  type CorrectionEventContext,
  type GameCatalogItem,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";

import { relayTextByEvent } from "../events/relay-text";
import { sourcePitchIdLabel } from "./pitch-source-id";

export type CorrectionGameScope = "review" | "ready" | "all";

export interface EventPresentation {
  readonly event: StagingRelayEvent;
  readonly kindLabel: string;
  readonly location: string;
  readonly title: string;
  readonly summary: string;
  readonly stateText: string;
  readonly searchText: string;
  readonly startsHalf: boolean;
}

export interface EventTimelinePresentation {
  readonly kind: "event";
  readonly key: string;
  readonly presentation: EventPresentation;
}

export type CorrectionTimelinePresentation = EventTimelinePresentation;

const labels: Readonly<Record<StagingRelayEvent["kind"], string>> = {
  half_inning_start: "이닝 시작",
  batter_start: "타석 시작",
  pitch: "투구",
  plate_result: "타석 결과",
  runner_advance: "주자 이동",
  substitution: "선수 교체",
  review: "비디오 판독",
  administrative: "중계 안내",
  unresolved: "미해석 원문",
};

const results: Readonly<Record<string, string>> = {
  single: "1루타",
  double: "2루타",
  triple: "3루타",
  home_run: "홈런",
  walk: "볼넷",
  intentional_walk: "고의4구",
  hit_by_pitch: "몸에 맞는 공",
  strikeout: "삼진",
  field_out: "범타",
  sacrifice_bunt: "희생번트",
  sacrifice_fly: "희생플라이",
  fielder_choice: "야수선택",
  reached_on_error: "실책 출루",
  interference: "방해 출루",
  double_play: "병살타",
  triple_play: "삼중살",
  other: "기타 결과",
};

const battedBalls: Readonly<Record<string, string>> = {
  ground_ball: "땅볼",
  fly_ball: "뜬공",
  line_drive: "직선타",
  popup: "내야 뜬공",
};

const runnerReasons: Readonly<Record<string, string>> = {
  stolen_base: "도루",
  caught_stealing: "도루 실패",
  pickoff: "견제",
  wild_pitch: "폭투",
  passed_ball: "포일",
  balk: "보크",
  defensive_indifference: "수비 무관심 진루",
  error: "실책",
  appeal: "어필",
  other: "기타",
};

export function correctionGameKey(game: GameCatalogItem): string {
  return `${game.authority}:${game.gameId}`;
}

export function filterCorrectionGames(
  games: readonly GameCatalogItem[],
  scope: CorrectionGameScope,
  query: string,
): GameCatalogItem[] {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  return games
    .filter((game) => game.authority === "staging" || game.authority === "quarantine")
    .filter(
      (game) =>
        scope === "all" ||
        (scope === "review" ? game.authority === "quarantine" : game.authority === "staging"),
    )
    .filter(
      (game) =>
        normalized === "" ||
        `${game.gameId} ${game.season ?? ""}`.toLocaleLowerCase("ko-KR").includes(normalized),
    )
    .sort(
      (left, right) =>
        Number(right.authority === "quarantine") - Number(left.authority === "quarantine") ||
        right.blockingFindings - left.blockingFindings ||
        compareCanonicalStrings(left.gameId, right.gameId),
    );
}

export function correctionGameLabel(game: GameCatalogItem): string {
  const counts = [
    game.blockingFindings > 0 ? `차단 ${String(game.blockingFindings)}` : "",
    game.warningFindings > 0 ? `경고 ${String(game.warningFindings)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `${game.gameId} · ${catalogAuthorityLabel(game.authority)}${counts === "" ? "" : ` · ${counts}`}`;
}

export function catalogAuthorityLabel(authority: CatalogAuthority | string): string {
  if (authority === "quarantine") return "검토 필요";
  if (authority === "staging") return "적재 가능";
  if (authority === "database") return "데이터베이스";
  return "원천 실패";
}

export function eventKindLabel(kind: StagingRelayEvent["kind"]): string {
  return labels[kind];
}
export function pitchCallLabel(value: string): string {
  return value.replaceAll("_", " ");
}
export function plateResultLabel(value: string): string {
  return results[value] ?? value;
}
export function battedBallTypeLabel(value: string): string {
  return battedBalls[value] ?? value;
}
export function runnerReasonLabel(value: string): string {
  return runnerReasons[value] ?? value;
}
export function substitutionRoleLabel(value: string): string {
  return (
    (
      { batter: "타자", runner: "주자", pitcher: "투수", fielder: "야수" } as Record<string, string>
    )[value] ?? value
  );
}

export function buildEventPresentations(
  document: StagingGameDocumentV2,
  contexts: readonly CorrectionEventContext[],
): EventPresentation[] {
  const names = playerNames(document);
  const text = relayTextByEvent(document);
  const contextById = new Map(contexts.map((item) => [item.eventId, item]));
  return document.events.map((event, index) => {
    const context = contextById.get(event.identity.eventId);
    const location = `${String(event.inning)}회${event.half === "top" ? "초" : "말"}`;
    const title = text.get(event.identity.eventId) ?? labels[event.kind];
    const summary = eventSummary(event, document, names);
    const stateText = context === undefined ? "상태 계산 없음" : stateSummary(context, names);
    return {
      event,
      kindLabel: labels[event.kind],
      location,
      title,
      summary,
      stateText,
      searchText: [
        location,
        labels[event.kind],
        title,
        summary,
        stateText,
        event.identity.eventId,
        JSON.stringify(event.payload),
      ]
        .join(" ")
        .toLocaleLowerCase("ko-KR"),
      startsHalf:
        index === 0 ||
        document.events[index - 1]?.inning !== event.inning ||
        document.events[index - 1]?.half !== event.half,
    };
  });
}

export function buildCorrectionTimeline(
  presentations: readonly EventPresentation[],
): CorrectionTimelinePresentation[] {
  return presentations.map((presentation) => ({
    kind: "event",
    key: presentation.event.identity.eventId,
    presentation,
  }));
}

export function playerDisplay(document: StagingGameDocumentV2, playerId: string | null): string {
  if (playerId === null || playerId === "") return "미확정";
  const name = playerNames(document).get(playerId);
  return name === undefined ? `명단 외 선수 (${playerId})` : `${name} (${playerId})`;
}

function eventSummary(
  event: StagingRelayEvent,
  document: StagingGameDocumentV2,
  names: ReadonlyMap<string, string>,
): string {
  const player = (id: string | undefined): string =>
    id === undefined ? "미확정" : (names.get(id) ?? id);
  if (event.kind === "half_inning_start")
    return `${document.teams[event.half === "top" ? "away" : "home"].name} 공격`;
  if (event.kind === "batter_start")
    return `${player(event.payload.batterId)} · 투수 ${player(event.payload.pitcherId)}`;
  if (event.kind === "pitch")
    return `${event.payload.call.replaceAll("_", " ")} · ${sourcePitchIdLabel(event.payload.sourcePitchId)}`;
  if (event.kind === "plate_result")
    return [
      results[event.payload.result] ?? event.payload.result,
      event.payload.battedBallType === undefined ? "" : battedBalls[event.payload.battedBallType],
      event.payload.isBunt === true ? "번트" : "",
      `타자 ${player(event.payload.batterId)}`,
      `투수 ${player(event.payload.pitcherId)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  if (event.kind === "runner_advance") {
    const link =
      event.payload.context.kind === "plate_result"
        ? `결과 ${event.payload.context.plateResultEventId} 연결`
        : runnerReasons[event.payload.context.reason];
    return `${player(event.payload.runnerId)} · ${base(event.payload.fromBase)}→${base(event.payload.toBase)} · ${event.payload.outcome} · ${link}`;
  }
  if (event.kind === "substitution")
    return `${player(event.payload.outgoingPlayerId)} → ${player(event.payload.incomingPlayerId)} · ${substitutionRoleLabel(event.payload.role)}`;
  if (event.kind === "review") return event.payload.decision ?? "판독 내용 미확정";
  if (event.kind === "administrative") return event.payload.code;
  return `${event.payload.sourceType}${event.payload.suspectedKind === undefined ? "" : ` · 추정 ${labels[event.payload.suspectedKind]}`}`;
}

function stateSummary(context: CorrectionEventContext, names: ReadonlyMap<string, string>): string {
  const bases = context.after.bases
    .map((id, index) => (id === null ? "" : `${String(index + 1)}루 ${names.get(id) ?? id}`))
    .filter(Boolean)
    .join(" · ");
  return `B${String(context.after.balls)} S${String(context.after.strikes)} O${String(context.after.outs)} · ${bases || "주자 없음"} · ${String(context.after.awayScore)}:${String(context.after.homeScore)}${context.applied ? "" : " · 적용 차단"}`;
}

function playerNames(document: StagingGameDocumentV2): Map<string, string> {
  return new Map(
    [...document.rosters.away.players, ...document.rosters.home.players].map((item) => [
      item.playerId,
      item.name,
    ]),
  );
}

function base(value: number): string {
  return value === 0 ? "타자" : value === 4 ? "홈" : `${String(value)}루`;
}
