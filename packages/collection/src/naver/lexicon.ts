import type {
  BattedBallType,
  PitchCall,
  PlateResult,
  RunnerAdvanceReason,
  RunnerOutKind,
  StagingRelayEvent,
} from "@kbo/contracts";

import { decide, matched, type DecisionCandidate, type ParseDecision } from "./decision.js";
import type { CanonicalNaverRow } from "./model.js";

const kindAliases: Readonly<Record<string, StagingRelayEvent["kind"]>> = {
  half_start: "half_inning_start",
  half_inning_start: "half_inning_start",
  batter_start: "batter_start",
  plate_appearance_start: "batter_start",
  pitch: "pitch",
  plate_result: "plate_result",
  plate_appearance_result: "plate_result",
  runner: "runner_advance",
  runner_advance: "runner_advance",
  runner_play: "runner_advance",
  substitution: "substitution",
  review: "review",
  administrative: "administrative",
  unresolved: "unresolved",
};

const resultAliases: Readonly<Record<string, PlateResult>> = {
  single: "single",
  double: "double",
  triple: "triple",
  home_run: "home_run",
  homerun: "home_run",
  walk: "walk",
  intentional_walk: "intentional_walk",
  hit_by_pitch: "hit_by_pitch",
  strikeout: "strikeout",
  field_out: "field_out",
  sacrifice_bunt: "sacrifice_bunt",
  sacrifice_fly: "sacrifice_fly",
  fielder_choice: "fielder_choice",
  reached_on_error: "reached_on_error",
  error: "reached_on_error",
  interference: "interference",
  double_play: "double_play",
  triple_play: "triple_play",
  other: "other",
};

const pitchAliases: Readonly<Record<string, PitchCall>> = {
  b: "ball",
  i: "ball",
  ball: "ball",
  t: "called_strike",
  c: "called_strike",
  called_strike: "called_strike",
  s: "swinging_strike",
  sw: "swinging_strike",
  k: "swinging_strike",
  swinging_strike: "swinging_strike",
  f: "foul",
  w: "foul",
  foul: "foul",
  h: "in_play",
  x: "in_play",
  inplay: "in_play",
  in_play: "in_play",
  d: "hit_by_pitch",
  hit_by_pitch: "hit_by_pitch",
  no_pitch: "no_pitch",
};

export function kindDecision(row: CanonicalNaverRow): ParseDecision<StagingRelayEvent["kind"]> {
  const candidates: DecisionCandidate<StagingRelayEvent["kind"]>[] = [];
  const explicit = row.explicitKind === null ? undefined : kindAliases[row.explicitKind];
  if (explicit !== undefined) {
    candidates.push(
      candidate(explicit, "kind.structured", 500, row.explicitKind ?? "", "structured"),
    );
  }
  const text = row.relayText ?? "";
  if (row.numericType === 7 && /피치클락.*(투수|타자).*위반.*(볼|스트라이크)/.test(text)) {
    candidates.push(candidate("pitch", "kind.text.pitch_clock", 450, text));
  }
  if (row.numericType === 7 && /투수판.*이탈|노피치|no.?pitch/i.test(text)) {
    candidates.push(candidate("pitch", "kind.text.no_pitch", 450, text));
  }
  if (row.numericType === 7 && /비디오\s*판독|리플레이\s*검토|챌린지/.test(text)) {
    candidates.push(candidate("review", "kind.text.review", 450, text));
  }
  const numericKind = numericSourceKind(row.numericType);
  if (numericKind !== null) {
    candidates.push(
      candidate(
        numericKind,
        `kind.numeric.${String(row.numericType)}`,
        300,
        String(row.numericType),
      ),
    );
  }
  return decide(candidates, "kind.unclassified", "행 종류를 확정할 근거가 없습니다.");
}

export function plateResultDecision(row: CanonicalNaverRow): ParseDecision<PlateResult> {
  const text = compact(row.relayText);
  const candidates: DecisionCandidate<PlateResult>[] = [];
  if (/쓰리번트.*아웃/.test(text)) {
    candidates.push(candidate("strikeout", "result.text.three_bunt_out", 650, text));
  }
  if (/희생번트/.test(text)) {
    candidates.push(candidate("sacrifice_bunt", "result.text.sacrifice_bunt", 620, text));
  }
  if (/희생플라이/.test(text)) {
    candidates.push(candidate("sacrifice_fly", "result.text.sacrifice_fly", 620, text));
  }
  const explicit = row.resultCode === null ? undefined : resultAliases[row.resultCode];
  if (
    /(?:땅볼|야수선택).*로출루/.test(text) &&
    (explicit === undefined || explicit === "field_out" || explicit === "fielder_choice")
  ) {
    candidates.push(candidate("fielder_choice", "result.text.fielder_choice_reach", 600, text));
  }
  if (explicit !== undefined) {
    candidates.push(
      candidate(explicit, "result.structured", 500, row.resultCode ?? "", "structured"),
    );
  }
  const patterns: readonly [RegExp, PlateResult, string, number][] = [
    [/홈런/i, "home_run", "home_run", 490],
    [/3루타/, "triple", "triple", 480],
    [/2루타/, "double", "double", 470],
    [/1루타|안타/, "single", "single", 460],
    [/고의4구|고의사구|고의볼넷/, "intentional_walk", "intentional_walk", 450],
    [/볼넷/, "walk", "walk", 440],
    [/몸에맞는볼|사구/, "hit_by_pitch", "hit_by_pitch", 430],
    [/삼중살/, "triple_play", "triple_play", 420],
    [/병살/, "double_play", "double_play", 410],
    [/삼진|낫아웃/, "strikeout", "strikeout", 400],
    [/타격방해/, "interference", "interference", 390],
    [/실책/, "reached_on_error", "error", 380],
    [/야수선택|필더스초이스/, "fielder_choice", "fielder_choice", 370],
    [/아웃|땅볼|플라이|뜬공|직선타/, "field_out", "field_out", 300],
  ];
  for (const [pattern, value, ruleId, specificity] of patterns) {
    if (pattern.test(text)) {
      candidates.push(
        candidate(value, `result.text.${ruleId}`, 300, text, "exact_text", specificity),
      );
    }
  }
  return decide(candidates, "result.unclassified", "타석 결과를 확정할 근거가 없습니다.");
}

export function pitchCallDecision(row: CanonicalNaverRow): ParseDecision<PitchCall> {
  const text = compact(row.relayText);
  const candidates: DecisionCandidate<PitchCall>[] = [];
  if (/피치클락.*위반/.test(text)) {
    if (/스트라이크/.test(text)) {
      candidates.push(candidate("automatic_strike", "pitch.text.clock_strike", 650, text));
    } else if (/볼/.test(text)) {
      candidates.push(candidate("automatic_ball", "pitch.text.clock_ball", 650, text));
    }
  }
  const patterns: readonly [RegExp, PitchCall, string, number][] = [
    [/투수판.*이탈|노피치|no.?pitch/i, "no_pitch", "no_pitch", 600],
    [/몸에맞/, "hit_by_pitch", "hit_by_pitch", 590],
    [/타격/, "in_play", "in_play", 580],
    [/파울팁/, "foul_tip", "foul_tip", 570],
    [/번트.*파울|파울.*번트/, "foul_bunt", "foul_bunt", 560],
    [/파울/, "foul", "foul", 500],
    [/헛스윙/, "swinging_strike", "swinging_strike", 490],
    [/스트라이크/, "called_strike", "called_strike", 480],
    [/볼(?!넷)/, "ball", "ball", 470],
  ];
  for (const [pattern, value, ruleId, specificity] of patterns) {
    if (pattern.test(text)) {
      candidates.push(
        candidate(value, `pitch.text.${ruleId}`, 500, text, "exact_text", specificity),
      );
    }
  }
  const explicit = row.pitchCallCode === null ? undefined : pitchAliases[row.pitchCallCode];
  if (explicit !== undefined) {
    candidates.push(
      candidate(explicit, "pitch.structured", 400, row.pitchCallCode ?? "", "structured"),
    );
  }
  return decide(candidates, "pitch.call_missing", "투구 판정을 확정할 근거가 없습니다.");
}

export function battedBallTypeDecision(textValue: string | null): ParseDecision<BattedBallType> {
  const text = compact(textValue);
  const patterns: readonly [RegExp, BattedBallType, string, number][] = [
    [/내야플라이|인필드플라이|팝플라이/, "popup", "popup", 400],
    [/직선타|라인드라이브/, "line_drive", "line_drive", 390],
    [/땅볼/, "ground_ball", "ground_ball", 380],
    [/플라이|뜬공/, "fly_ball", "fly_ball", 300],
  ];
  const candidates = patterns.flatMap(([pattern, value, ruleId, specificity]) =>
    pattern.test(text)
      ? [candidate(value, `batted_ball.text.${ruleId}`, 300, text, "exact_text", specificity)]
      : [],
  );
  return candidates.length === 0
    ? { status: "not_applicable" }
    : decide(candidates, "batted_ball.conflict", "타구 유형이 서로 충돌합니다.");
}

export function buntDecision(textValue: string | null): ParseDecision<boolean> {
  const text = compact(textValue);
  return /번트|bunt/i.test(text)
    ? matched(true, "bunt.text.explicit", [{ source: "exact_text", detail: text }])
    : { status: "not_applicable" };
}

export function runnerFromBase(textValue: string | null): number | null {
  const matchedBase = /([123])\s*루\s*주자/.exec(textValue ?? "")?.[1];
  return matchedBase === undefined ? null : Number(matchedBase);
}

export function runnerName(textValue: string | null): string | null {
  return /[123]\s*루\s*주자\s+([^:]+)\s*:/.exec(textValue ?? "")?.[1]?.trim() ?? null;
}

export function batterActorName(textValue: string | null): string | null {
  const text = textValue ?? "";
  if (!text.includes(":")) return null;
  return (
    text
      .split(":", 1)[0]
      ?.replace(/^\d+번\s*타자\s*/, "")
      .trim() ?? null
  );
}

export function battingOrderMention(textValue: string | null): number | null {
  const value = /([1-9])\s*번\s*타자/.exec(textValue ?? "")?.[1];
  return value === undefined ? null : Number(value);
}

export function runnerOutcomeDecision(
  row: CanonicalNaverRow,
): ParseDecision<"safe" | "out" | "scored"> {
  const text = row.relayText ?? "";
  const candidates: DecisionCandidate<"safe" | "out" | "scored">[] = [];
  if (/홈인|득점/.test(text)) candidates.push(candidate("scored", "runner.text.scored", 600, text));
  if (/아웃|견제사|주루사/.test(text))
    candidates.push(candidate("out", "runner.text.out", 550, text));
  if (/진루|도루\s*성공/.test(text))
    candidates.push(candidate("safe", "runner.text.safe", 500, text));
  if (/실패/.test(text)) candidates.push(candidate("out", "runner.text.failed", 450, text));
  if (["safe", "out", "scored"].includes(row.outcomeCode ?? "")) {
    candidates.push(
      candidate(
        row.outcomeCode as "safe" | "out" | "scored",
        "runner.structured.outcome",
        400,
        row.outcomeCode ?? "",
        "structured",
      ),
    );
  }
  return decide(candidates, "runner.outcome_missing", "주자 이동 결과를 확정할 수 없습니다.");
}

export function runnerDestination(
  textValue: string | null,
  fromBase: number,
  outcome: "safe" | "out" | "scored",
): number | null {
  if (outcome === "scored") return 4;
  const destination = /([123])\s*루(?:까지|로)?\s*(?:진루|도루|아웃|태그아웃)/.exec(
    textValue ?? "",
  )?.[1];
  return destination === undefined ? (outcome === "out" ? fromBase : null) : Number(destination);
}

export function runnerOutKind(textValue: string | null): RunnerOutKind {
  const text = textValue ?? "";
  if (/어필/.test(text)) return /포스/.test(text) ? "appeal_force" : "appeal_time";
  if (/타격방해|주루방해/.test(text)) return "interference";
  if (/포스아웃/.test(text)) return "force";
  return "tag";
}

export function independentReasonDecision(
  row: CanonicalNaverRow,
): ParseDecision<RunnerAdvanceReason> {
  const text = row.relayText ?? "";
  const candidates: DecisionCandidate<RunnerAdvanceReason>[] = [];
  const allowed: readonly RunnerAdvanceReason[] = [
    "stolen_base",
    "caught_stealing",
    "pickoff",
    "wild_pitch",
    "passed_ball",
    "balk",
    "defensive_indifference",
    "error",
    "appeal",
    "other",
  ];
  if (row.reasonCode !== null && allowed.includes(row.reasonCode as RunnerAdvanceReason)) {
    candidates.push(
      candidate(
        row.reasonCode as RunnerAdvanceReason,
        "runner_reason.structured",
        500,
        row.reasonCode,
        "structured",
      ),
    );
  }
  const patterns: readonly [RegExp, RunnerAdvanceReason, string, number][] = [
    [/도루.*진루(?!.*아웃)/, "stolen_base", "stolen_base_safe", 500],
    [
      /도루\s*실패(?:로|하여|해)?\s*(?:아웃|태그아웃)?(?!.*실패시)/,
      "caught_stealing",
      "caught_stealing",
      490,
    ],
    [/도루/, "stolen_base", "stolen_base", 400],
    [/견제/, "pickoff", "pickoff", 390],
    [/폭투/, "wild_pitch", "wild_pitch", 380],
    [/포일|패스트볼/, "passed_ball", "passed_ball", 370],
    [/보크/, "balk", "balk", 360],
    [/수비무관심/, "defensive_indifference", "defensive_indifference", 350],
    [/실책/, "error", "error", 340],
    [/어필/, "appeal", "appeal", 330],
    [/주자의\s*재치|주루\s*방해|다른\s*주자\s*수비|태그\s*아웃/, "other", "other", 300],
  ];
  for (const [pattern, value, ruleId, specificity] of patterns) {
    if (pattern.test(text)) {
      candidates.push(
        candidate(value, `runner_reason.text.${ruleId}`, 400, text, "exact_text", specificity),
      );
    }
  }
  return candidates.length === 0
    ? { status: "not_applicable" }
    : decide(candidates, "runner_reason.conflict", "독립 주자 이동 사유가 서로 충돌합니다.");
}

export function substitutionSegments(
  textValue: string | null,
): { readonly outgoing: string; readonly incoming: string } | null {
  const match = /^\s*(.+?)\s*:\s*(.+?)\s*\((?:으)?\)로\s*교체\s*$/.exec(textValue ?? "");
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { outgoing: match[1].trim(), incoming: match[2].trim() };
}

export function substitutionRole(
  roleHint: string,
  textValue: string | null,
  positionChange: boolean,
): "batter" | "runner" | "pitcher" | "fielder" {
  if (positionChange) return "fielder";
  const compactText = `${roleHint} ${textValue ?? ""}`.toLowerCase();
  if (/투수|pitcher/.test(compactText)) return "pitcher";
  if (/대타|타자/.test(roleHint.toLowerCase())) return "batter";
  if (/대주자|주자/.test(roleHint.toLowerCase())) return "runner";
  return "fielder";
}

export function textIndicatesPositionChange(textValue: string | null): boolean {
  return /수비위치/.test(textValue ?? "");
}

export function textIndicatesFieldingSide(textValue: string | null): boolean {
  return /수비/.test(textValue ?? "");
}

export function battingOrderFromPosition(position: string | null): number | null {
  const value = /([1-9])번\s*타자/.exec(position ?? "")?.[1];
  return value === undefined ? null : Number(value);
}

export function inferredBatterDestination(
  result: PlateResult,
  textValue: string | null,
): number | null {
  const text = compact(textValue);
  if (
    result === "strikeout" &&
    /낫아웃/.test(text) &&
    !/(?:태그|터치|송구)아웃/.test(text) &&
    /(?:출루|폭투|포일|실책)/.test(text)
  ) {
    return 1;
  }
  if (
    ["sacrifice_bunt", "sacrifice_fly", "double_play", "triple_play"].includes(result) &&
    (/(?:실책|병살타).*출루|실책으로출루/.test(text) ||
      (/희생(?:번트|플라이)/.test(text) && /실책|야수선택|출루/.test(text)))
  ) {
    return 1;
  }
  return null;
}

export function pitchClockWarningAward(textValue: string | null): PitchCall | null {
  const text = compact(textValue);
  if (!/피치클락/.test(text) || !/경고/.test(text)) return null;
  if (/\d+회(?:초|말)|\d+번타순|(?:\d+구후|초구전)/.test(text)) return null;
  if (/투수/.test(text)) return "automatic_ball";
  if (/타자/.test(text)) return "automatic_strike";
  return null;
}

export function reviewDecision(
  row: CanonicalNaverRow,
): ParseDecision<"requested" | "upheld" | "overturned" | "inconclusive"> {
  const allowed = ["requested", "upheld", "overturned", "inconclusive"] as const;
  if (allowed.includes(row.reviewDecision as (typeof allowed)[number])) {
    return matched(row.reviewDecision as (typeof allowed)[number], "review.structured", [
      { source: "structured", detail: row.reviewDecision ?? "" },
    ]);
  }
  const text = row.relayText ?? "";
  if (/번복/.test(text)) return matched("overturned", "review.text.overturned", evidence(text));
  if (/유지/.test(text)) return matched("upheld", "review.text.upheld", evidence(text));
  if (/판독.*요청|챌린지/.test(text)) {
    return matched("requested", "review.text.requested", evidence(text));
  }
  return { status: "not_applicable" };
}

export function administrativeCode(
  row: CanonicalNaverRow,
): "announcement" | "mound_visit" | "break" | "footer" | "other" {
  const allowed = ["announcement", "mound_visit", "break", "footer", "other"] as const;
  if (allowed.includes(row.administrativeCode as (typeof allowed)[number])) {
    return row.administrativeCode as (typeof allowed)[number];
  }
  const text = row.relayText ?? "";
  if (/마운드\s*방문/.test(text)) return "mound_visit";
  if (/경기\s*종료|승리투수|패전투수|무승부/.test(text)) return "footer";
  if (/휴식|정비|중단/.test(text)) return "break";
  return "announcement";
}

export function isNonRbiRunnerText(textValue: string | null): boolean {
  return /실책|폭투|포일|보크|도루|견제|다른\s*주자\s*수비|주자의\s*재치|주루\s*방해|wild\s*pitch|passed\s*ball|balk|stolen\s*base|pickoff/i.test(
    textValue ?? "",
  );
}

export function resultAllowsBattedBall(result: PlateResult): boolean {
  return !["walk", "intentional_walk", "hit_by_pitch", "strikeout", "interference"].includes(
    result,
  );
}

export function pitchCallMatchesAward(call: PitchCall, award: PitchCall): boolean {
  return award === "automatic_ball"
    ? call === "ball"
    : call === "called_strike" || call === "swinging_strike";
}

function numericSourceKind(type: number | null): StagingRelayEvent["kind"] | null {
  if (type === 7 || type === 44 || type === 99) return "administrative";
  return (
    (
      {
        0: "half_inning_start",
        1: "pitch",
        2: "substitution",
        8: "batter_start",
        13: "plate_result",
        23: "plate_result",
        14: "runner_advance",
        24: "runner_advance",
      } as const
    )[type ?? -1] ?? null
  );
}

function candidate<Value>(
  value: Value,
  ruleId: string,
  strength: number,
  detail: string,
  source: "structured" | "source_state" | "exact_text" | "roster" | "context" = "exact_text",
  specificity = 0,
): DecisionCandidate<Value> {
  return { value, ruleId, strength, specificity, evidence: [{ source, detail }] };
}

function evidence(detail: string) {
  return [{ source: "exact_text" as const, detail }];
}

function compact(value: string | null): string {
  return (value ?? "").normalize("NFKC").replace(/\s/g, "");
}
