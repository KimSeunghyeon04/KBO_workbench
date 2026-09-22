import { parseStagingGameDocumentV2, type StagingRelayEvent } from "@kbo/contracts";

import { findTerminalPitchForPlateResult } from "./rules.js";
import {
  buildPlayIndex,
  findBatterHeadersConfirmedBySubstitution,
  type PlayIndex,
} from "./compiler/play-index.js";
import type { CompileContext, MutableState } from "./compiler/model.js";
import { compileBaserunnerLines, compilePitchFacts } from "./compiler/derived-facts.js";
import { applyLedgerEvent } from "./compiler/event-transition.js";
import { comparePlayerLine } from "./compiler/statistics.js";
import { addFinding, compareFindings, findingFor } from "./compiler/findings.js";
import {
  compareFinalObservedScore,
  compareIndependentPlayObservedState,
  compareOfficialRecords,
  compareObservedState,
  comparePlatePlayObservedState,
  validateTracking,
} from "./compiler/validation.js";
import {
  cloneContext,
  cloneState,
  initialState,
  partialPlateAppearance,
  playerSides,
  snapshot,
} from "./compiler/state.js";
import type { CompiledPlay, GameState, ReplayFrame, ReplayResult } from "./types.js";

export function compileStagingGameDocumentV2(input: unknown): ReplayResult {
  const document = parseStagingGameDocumentV2(input);
  const context: CompileContext = {
    document,
    playerSides: playerSides(document),
    findings: [],
    plateAppearances: [],
    batterLines: new Map(),
    pitcherLines: new Map(),
    batterHeadersConfirmedBySubstitution: findBatterHeadersConfirmedBySubstitution(document),
    observationMismatchFields: new Set(),
    uncertainRbiBatterIds: new Set(),
  };
  const links: PlayIndex = buildPlayIndex(document);
  const hitByPitchTerminalPitchIds = findHitByPitchTerminalPitchIds(document.events);
  const buntStrikeoutPitchIds = new Set(
    document.events.flatMap((event, index) => {
      if (event.kind !== "plate_result" || event.payload.result !== "strikeout") return [];
      const pitch = findTerminalPitchForPlateResult(document.events, index);
      return pitch?.payload.call === "foul_bunt" ? [pitch.identity.eventId] : [];
    }),
  );
  let state = initialState();
  const frames: ReplayFrame[] = [];
  const plays: CompiledPlay[] = [];
  const playByAttachedEvent = new Map<string, string>();
  const stateByAttachedEvent = new Map<
    string,
    { before: GameState; after: GameState; applied: boolean }
  >();

  for (const event of document.events) {
    const eventId = event.identity.eventId;
    const attachedPlayId = playByAttachedEvent.get(eventId);
    if (attachedPlayId !== undefined) {
      const attachedState = stateByAttachedEvent.get(eventId);
      frames.push({
        eventId,
        sequence: event.sequence,
        kind: event.kind,
        playId: attachedPlayId,
        before: attachedState?.before ?? snapshot(state),
        after: attachedState?.after ?? snapshot(state),
        applied: attachedState?.applied ?? false,
      });
      continue;
    }

    const before = snapshot(state);
    const candidate = cloneState(state);
    const local = cloneContext(context);
    for (const linkedFinding of links.findingByEvent.get(eventId) ?? []) {
      local.findings.push(linkedFinding);
    }
    if (event.kind === "plate_result" && links.invalidPlayLeaderIds.has(eventId)) {
      addFinding(
        local,
        event,
        "invalid_plate_result_link",
        "source",
        "타석 결과와 주자 이동 사이에 다른 상태 변경 행이 있습니다.",
      );
    }
    const application = applyLedgerEvent(
      candidate,
      event,
      local,
      links.linkedByResult.get(eventId) ?? [],
      links.nonStateByResult.get(eventId) ?? [],
      links.independentByLeader.get(eventId) ?? [],
      links.nonStateByIndependentLeader.get(eventId) ?? [],
    );
    const newFindings = local.findings.slice(context.findings.length);
    const blocking = newFindings.some((finding) => finding.severity === "blocking");
    const resumableBoundary =
      event.kind === "half_inning_start" &&
      newFindings
        .filter((finding) => finding.severity === "blocking")
        .every((finding) => finding.code === "source_half_incomplete");
    const applied = !blocking || resumableBoundary;
    if (applied) {
      state = candidate;
      context.plateAppearances = local.plateAppearances;
      context.batterLines = local.batterLines;
      context.pitcherLines = local.pitcherLines;
      if (event.kind === "plate_result") {
        comparePlatePlayObservedState(state, event, links.linkedByResult.get(eventId) ?? [], local);
      } else if (event.kind === "runner_advance" && event.payload.context.kind === "independent") {
        compareIndependentPlayObservedState(
          state,
          links.independentByLeader.get(eventId) ?? [event],
          local,
        );
      } else if (event.kind === "pitch") {
        const terminalBuntDisplay =
          before.strikes === 2 &&
          state.strikes === 3 &&
          event.observedStateAfter?.strikes === 2 &&
          buntStrikeoutPitchIds.has(eventId);
        if (terminalBuntDisplay) {
          local.findings.push({
            ...findingFor(
              local,
              event,
              "source_terminal_bunt_count_display",
              "source",
              "번트 파울 뒤 삼진 결과가 확인되어 원천의 2스트라이크 종결 표기를 보존했습니다.",
              [{ field: "strikes", expected: 2, actual: 3 }],
            ),
            severity: "warning",
          });
        }
        // 원천의 투구 행 snapshot은 다음 결과 행의 아웃·주자·점수를 미리 담는 경우가
        // 있다. 투구 자체로 확정되는 카운트만 비교하고, 나머지는 play 종료 지점에서
        // 비교한다.
        compareObservedState(state, event, local, {
          // 원천은 사구 결과의 종결 표기로 balls=4를 보낼 수 있지만 사구 자체는
          // 볼카운트를 올리는 판정이 아니다. 원천값은 보존하되 strikes는 계속 검증한다.
          includeBalls:
            event.payload.call !== "hit_by_pitch" &&
            !hitByPitchTerminalPitchIds.has(event.identity.eventId),
          includeStrikes: !terminalBuntDisplay,
          includeBases: false,
          includeOuts: false,
          includeScore: false,
        });
      }
      context.observationMismatchFields = local.observationMismatchFields;
      context.uncertainRbiBatterIds = local.uncertainRbiBatterIds;
    }
    context.findings = local.findings;
    const after = snapshot(state);
    const playId = `play:${eventId}`;
    const relayEventIds =
      application.relayEventIds.length === 0 ? [eventId] : application.relayEventIds;
    const relayTexts =
      application.relayTexts.length === 0 ? relayTextsOf([event]) : application.relayTexts;
    plays.push({
      playId,
      sequence: event.sequence,
      kind: event.kind,
      inning: event.inning,
      half: event.half,
      relayEventIds,
      relayTexts,
      before,
      after,
      applied,
      movements: applied ? application.movements : [],
    });
    for (const attachedId of relayEventIds.slice(1)) {
      playByAttachedEvent.set(attachedId, playId);
      stateByAttachedEvent.set(attachedId, { before, after, applied });
    }
    frames.push({
      eventId,
      sequence: event.sequence,
      kind: event.kind,
      playId,
      before,
      after,
      applied,
    });
  }

  finishDocument(state, context);
  compareFinalObservedScore(state, document, context);
  const pitchFacts = compilePitchFacts(document.events, context.plateAppearances, frames);
  validateTracking(document, pitchFacts, context);
  compareOfficialRecords(context);
  return {
    gameId: document.metadata.gameId,
    finalState: snapshot(state),
    frames,
    plays,
    plateAppearances: context.plateAppearances,
    pitchFacts,
    batterLines: [...context.batterLines.values()].sort(comparePlayerLine),
    pitcherLines: [...context.pitcherLines.values()]
      .sort(comparePlayerLine)
      .map((line) => ({ ...line, earnedRuns: null })),
    baserunnerLines: compileBaserunnerLines(plays, context.playerSides),
    findings: [...context.findings].sort(compareFindings),
  };
}

function findHitByPitchTerminalPitchIds(events: readonly StagingRelayEvent[]): ReadonlySet<string> {
  const eventIds = new Set<string>();
  for (let resultIndex = 0; resultIndex < events.length; resultIndex += 1) {
    const result = events[resultIndex];
    if (result?.kind !== "plate_result" || result.payload.result !== "hit_by_pitch") continue;
    const pitch = findTerminalPitchForPlateResult(events, resultIndex);
    if (pitch !== undefined && ["ball", "hit_by_pitch"].includes(pitch.payload.call)) {
      eventIds.add(pitch.identity.eventId);
    }
  }
  return eventIds;
}

function finishDocument(state: MutableState, context: CompileContext): void {
  const walkOff =
    state.half === "bottom" &&
    state.inning >= context.document.metadata.scheduledInnings &&
    state.homeScore > state.awayScore;
  const declarations = context.document.events.filter(
    (event) => event.kind === "administrative" && event.payload.code === "called_game",
  );
  const declaration = declarations.at(-1);
  const validDeclaration =
    state.halfActive &&
    declaration !== undefined &&
    context.document.metadata.status === "final" &&
    declaration.inning === state.inning &&
    declaration.half === state.half &&
    context.document.events
      .slice(declaration.sequence + 1)
      .every((event) => event.kind === "administrative" || event.kind === "review");
  for (const entry of declarations) {
    if (entry !== declaration || !validDeclaration) {
      addFinding(
        context,
        entry,
        "invalid_called_game_declaration",
        "source",
        "콜드게임 종료 선언은 종료 경기의 마지막 반이닝에 있어야 하며 이후 경기 진행 행이 없어야 합니다.",
      );
    }
  }
  if (!state.halfActive) return;
  const calledGame =
    validDeclaration ||
    (context.document.metadata.status === "final" &&
      state.inning < context.document.metadata.scheduledInnings);
  if (state.activePlateAppearance !== null) {
    const reason =
      state.outs === 3
        ? "third_out"
        : walkOff
          ? "walk_off"
          : calledGame
            ? "called_game"
            : "end_of_document";
    const endEventId =
      reason === "end_of_document"
        ? null
        : reason === "called_game" && validDeclaration
          ? (declaration?.identity.eventId ?? null)
          : (context.document.events.at(-1)?.identity.eventId ?? null);
    context.plateAppearances.push(partialPlateAppearance(state, endEventId, reason));
  }
  if (context.document.metadata.status === "final" && state.outs < 3 && !walkOff && !calledGame) {
    context.findings.push({
      code: "final_game_has_incomplete_half",
      category: "source",
      severity: "blocking",
      message: "종료 경기의 마지막 반이닝이 3아웃 또는 끝내기로 닫히지 않았습니다.",
      gameId: context.document.metadata.gameId,
      details: [{ field: "outs", expected: 3, actual: state.outs }],
    });
  }
}

function relayTextsOf(events: readonly StagingRelayEvent[]): string[] {
  return events.flatMap((event) => (event.relayText === undefined ? [] : [event.relayText]));
}
