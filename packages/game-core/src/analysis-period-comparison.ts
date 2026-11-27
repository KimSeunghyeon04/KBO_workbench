import type {
  BattingStatisticsRow,
  PitchingStatisticsRow,
  PitchAnalysisSample,
  BatterProfileResponse,
  DisciplinePeriodInput,
  PeriodMetric,
  PitchProfileGroup,
  PitchRateGroup,
} from "@kbo/contracts";
import { battingStatistics, pitchingStatistics } from "./player-statistics.js";

type Observation = PeriodMetric["first"];
export const periodObservation = (
  value: number | null,
  numerator: number | null = null,
  denominator: number | null = null,
): Observation => ({ value, numerator, denominator });
export function periodMetric(
  group: string,
  label: string,
  unit: PeriodMetric["unit"],
  first: Observation,
  second: Observation,
  comparable = true,
): PeriodMetric {
  return {
    key: JSON.stringify([group, label]),
    group,
    label,
    unit,
    first,
    second,
    difference:
      !comparable || first.value === null || second.value === null
        ? null
        : second.value - first.value,
  };
}
const identity = {
  identity: "period-total",
  playerId: null,
  name: "전체",
  teamId: "",
  teamName: "전체",
};
const sum = <T>(rows: readonly T[], value: (row: T) => number) =>
  rows.reduce((n, r) => n + value(r), 0);
function batting(rows: readonly BattingStatisticsRow[]) {
  return battingStatistics({
    ...identity,
    games: sum(rows, (r) => r.games),
    plateAppearances: sum(rows, (r) => r.plateAppearances),
    atBats: sum(rows, (r) => r.atBats),
    hits: sum(rows, (r) => r.hits),
    doubles: sum(rows, (r) => r.doubles),
    triples: sum(rows, (r) => r.triples),
    homeRuns: sum(rows, (r) => r.homeRuns),
    walks: sum(rows, (r) => r.walks),
    intentionalWalks: sum(rows, (r) => r.intentionalWalks),
    hitByPitch: sum(rows, (r) => r.hitByPitch),
    strikeouts: sum(rows, (r) => r.strikeouts),
    sacrificeFlies: sum(rows, (r) => r.sacrificeFlies),
    sacrificeBunts: sum(rows, (r) => r.sacrificeBunts),
    runs: sum(rows, (r) => r.runs),
  });
}
function pitching(rows: readonly PitchingStatisticsRow[]) {
  return pitchingStatistics({
    ...identity,
    games: sum(rows, (r) => r.games),
    battersFaced: sum(rows, (r) => r.battersFaced),
    outsRecorded: sum(rows, (r) => r.outsRecorded),
    hits: sum(rows, (r) => r.hits),
    runs: sum(rows, (r) => r.runs),
    walks: sum(rows, (r) => r.walks),
    intentionalWalks: sum(rows, (r) => r.intentionalWalks),
    hitByPitch: sum(rows, (r) => r.hitByPitch),
    strikeouts: sum(rows, (r) => r.strikeouts),
    pitches: sum(rows, (r) => r.pitches),
    strikes: sum(rows, (r) => r.strikes),
    knownErGames: sum(rows, (r) => r.knownErGames),
    knownErOuts: sum(rows, (r) => r.knownErOuts),
    knownEarnedRuns: sum(rows, (r) => r.knownEarnedRuns),
  });
}
export function compareBattingPeriods(
  a: readonly BattingStatisticsRow[],
  b: readonly BattingStatisticsRow[],
) {
  const first = batting(a),
    second = batting(b);
  const metric = (
    label: string,
    unit: PeriodMetric["unit"],
    read: (r: BattingStatisticsRow) => Observation,
  ) => periodMetric("전체", label, unit, read(first), read(second));
  return [
    metric("타석", "number", (r) => periodObservation(r.plateAppearances)),
    metric("AVG", "number", (r) => periodObservation(r.avg, r.hits, r.atBats)),
    metric("OBP", "number", (r) =>
      periodObservation(r.obp, r.hits + r.walks + r.hitByPitch, r.obpDenominator),
    ),
    metric("SLG", "number", (r) => periodObservation(r.slg, r.totalBases, r.atBats)),
    metric("OPS", "number", (r) => periodObservation(r.ops)),
    metric("K%", "rate", (r) => periodObservation(r.kRate, r.strikeouts, r.plateAppearances)),
    metric("BB%", "rate", (r) => periodObservation(r.bbRate, r.walks, r.plateAppearances)),
  ];
}
export function comparePitchingPeriods(
  a: readonly PitchingStatisticsRow[],
  b: readonly PitchingStatisticsRow[],
) {
  const first = pitching(a),
    second = pitching(b);
  const metric = (
    label: string,
    unit: PeriodMetric["unit"],
    read: (r: PitchingStatisticsRow) => Observation,
  ) => periodMetric("전체", label, unit, read(first), read(second));
  return [
    metric("상대 타자 BF", "number", (r) => periodObservation(r.battersFaced)),
    metric("이닝 IP", "outs", (r) => periodObservation(r.outsRecorded)),
    metric("투구 수", "number", (r) => periodObservation(r.pitches)),
    metric("ERA", "number", (r) => periodObservation(r.era, r.knownEarnedRuns * 27, r.knownErOuts)),
    metric("ER 확인 경기 ERA", "number", (r) =>
      periodObservation(r.knownGamesEra, r.knownEarnedRuns * 27, r.knownErOuts),
    ),
    metric("ER 확인 경기 수", "number", (r) =>
      periodObservation(r.knownErGames, r.knownErGames, r.games),
    ),
    metric("K%", "rate", (r) => periodObservation(r.kRate, r.strikeouts, r.battersFaced)),
    metric("BB%", "rate", (r) => periodObservation(r.bbRate, r.walks, r.battersFaced)),
    metric("K−BB%", "rate", (r) =>
      periodObservation(r.kMinusBbRate, r.strikeouts - r.walks, r.battersFaced),
    ),
  ];
}
const none = periodObservation(null);
export function comparePitchProfilePeriods(
  a: PitchAnalysisSample,
  b: PitchAnalysisSample,
): PeriodMetric[] {
  const groups = [
    ...new Set([...a.profile.groups, ...b.profile.groups].map((g) => g.pitchType)),
  ].sort((x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1));
  const result: PeriodMetric[] = [];
  for (const type of groups) {
    const first = a.profile.groups.find((g) => g.pitchType === type),
      second = b.profile.groups.find((g) => g.pitchType === type);
    const add = (
      label: string,
      unit: PeriodMetric["unit"],
      read: (g: PitchProfileGroup, total: number) => Observation,
      comparable = true,
    ) =>
      result.push(
        periodMetric(
          type === null ? "원천 미제공 구종" : `구종 ${type}`,
          label,
          unit,
          first === undefined
            ? label === "사용률" && a.actualPitchCount > 0
              ? periodObservation(0, 0, a.actualPitchCount)
              : none
            : read(first, a.actualPitchCount),
          second === undefined
            ? label === "사용률" && b.actualPitchCount > 0
              ? periodObservation(0, 0, b.actualPitchCount)
              : none
            : read(second, b.actualPitchCount),
          comparable,
        ),
      );
    add("사용률", "rate", (g, n) => periodObservation(g.usageRate, g.actualPitches, n));
    add("평균 구속", "km/h", (g) => periodObservation(g.meanSpeedKph, null, g.speedCount));
    add(
      "보정 가로",
      "cm",
      (g) => periodObservation(g.calibratedXCm, null, g.calibratedCount),
      a.season === b.season && a.referenceSourceHash === b.referenceSourceHash,
    );
    add(
      "보정 세로",
      "cm",
      (g) => periodObservation(g.calibratedZCm, null, g.calibratedCount),
      a.season === b.season && a.referenceSourceHash === b.referenceSourceHash,
    );
    add(
      "보정 도착 시간",
      "ms",
      (g) => periodObservation(g.calibratedArrivalMs, null, g.calibratedCount),
      a.season === b.season && a.referenceSourceHash === b.referenceSourceHash,
    );
    add("Whiff%", "rate", (g) => periodObservation(g.whiffRate, g.whiffs, g.swings));
  }
  return result;
}
export function comparePitchRatePeriods(
  group: string,
  a: PitchRateGroup | undefined,
  b: PitchRateGroup | undefined,
) {
  const metric = (label: string, read: (r: PitchRateGroup) => Observation) =>
    periodMetric(
      group,
      label,
      "rate",
      a === undefined ? none : read(a),
      b === undefined ? none : read(b),
    );
  return [
    metric("Swing%", (r) => periodObservation(r.swingRate, r.swings, r.pitches)),
    metric("Whiff%", (r) => periodObservation(r.whiffRate, r.whiffs, r.swings)),
    metric("Contact%", (r) =>
      periodObservation(
        r.swings === 0 ? null : (r.swings - r.whiffs) / r.swings,
        r.swings - r.whiffs,
        r.swings,
      ),
    ),
    metric("Chase%", (r) => periodObservation(r.chaseRate, r.outsideSwings, r.outsidePitches)),
    metric("CSW%", (r) => periodObservation(r.cswRate, r.csw, r.pitches)),
    metric("PutAway%", (r) =>
      periodObservation(r.putAwayRate, r.terminalStrikeouts, r.twoStrikePitches),
    ),
    metric("인플레이 안타율", (r) =>
      periodObservation(r.inPlayHitRate, r.inPlayHits, r.inPlayResults),
    ),
  ];
}
export function compareBatterProfilePeriods(a: BatterProfileResponse, b: BatterProfileResponse) {
  const result = comparePitchRatePeriods("전체", a.total, b.total);
  for (const [label, first, second] of [
    ["구종", a.byType, b.byType],
    ["구속대", a.bySpeed, b.bySpeed],
    ["코스", a.cells, b.cells],
  ] as const) {
    const keys = [...new Set([...first, ...second].map((g) => g.key))].sort((x, y) => {
      if (label === "코스") {
        const rank = (key: string) => (4 - Math.floor(Number(key) / 5)) * 5 + (Number(key) % 5);
        return rank(x) - rank(y);
      }
      if (label === "구속대") {
        const left = Number.parseFloat(x),
          right = Number.parseFloat(y);
        if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
        if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
      }
      return x === y ? 0 : x < y ? -1 : 1;
    });
    for (const key of keys) {
      const group =
        label === "코스"
          ? `코스 ${5 - Math.floor(Number(key) / 5)}행 ${(Number(key) % 5) + 1}열`
          : `${label} ${key}`;
      result.push(
        ...comparePitchRatePeriods(
          group,
          first.find((g) => g.key === key),
          second.find((g) => g.key === key),
        ),
      );
    }
  }
  const keys = [
    null,
    ...[
      ...new Set([
        ...a.plateAppearances.byTerminalType.map((g) => g.key),
        ...b.plateAppearances.byTerminalType.map((g) => g.key),
      ]),
    ].sort(),
  ];
  for (const key of keys) {
    const first =
      key === null
        ? a.plateAppearances.total
        : a.plateAppearances.byTerminalType.find((g) => g.key === key);
    const second =
      key === null
        ? b.plateAppearances.total
        : b.plateAppearances.byTerminalType.find((g) => g.key === key);
    const group = key === null ? "종결 투구 전체" : `종결 구종 ${key}`;
    result.push(
      periodMetric(
        group,
        "AVG",
        "number",
        first ? periodObservation(first.avg, first.hits, first.ab) : none,
        second ? periodObservation(second.avg, second.hits, second.ab) : none,
      ),
    );
    result.push(
      periodMetric(
        group,
        "SLG",
        "number",
        first ? periodObservation(first.slg, first.totalBases, first.ab) : none,
        second ? periodObservation(second.slg, second.totalBases, second.ab) : none,
      ),
    );
    result.push(
      periodMetric(
        group,
        "완료 PA",
        "number",
        first ? periodObservation(first.pa) : none,
        second ? periodObservation(second.pa) : none,
      ),
    );
  }
  return result;
}
export function compareDisciplinePeriods(a: DisciplinePeriodInput, b: DisciplinePeriodInput) {
  const metric = (
    label: string,
    get: (r: DisciplinePeriodInput["conventionalBatter"]) => Observation,
  ) => periodMetric("전체", label, "rate", get(a.conventionalBatter), get(b.conventionalBatter));
  const whiff = ({ mapSwings: swings, mapWhiffs: whiffs }: DisciplinePeriodInput) => {
    return periodObservation(swings === 0 ? null : whiffs / swings, whiffs, swings);
  };
  return [
    metric("Zone%", (r) => periodObservation(r.zoneRate, r.zonePitches, r.pitches)),
    metric("Swing%", (r) => periodObservation(r.swingRate, r.swings, r.pitches)),
    metric("Z-Swing%", (r) => periodObservation(r.zoneSwingRate, r.zoneSwings, r.zonePitches)),
    metric("Chase%", (r) => periodObservation(r.chaseRate, r.outsideSwings, r.outsidePitches)),
    periodMetric("전체", "Whiff% (지도 표본)", "rate", whiff(a), whiff(b)),
  ];
}
