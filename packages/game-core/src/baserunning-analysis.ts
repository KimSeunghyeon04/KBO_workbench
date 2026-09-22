import type { AnalysisPlay, BaserunningOpportunity, BaserunningResponse } from "@kbo/contracts";
/** One candidate per runner and atomic single, including runners with no movement row. */
export function baserunningOpportunities(
  plays: readonly AnalysisPlay[],
  playerId: string,
): BaserunningOpportunity[] {
  const result: BaserunningOpportunity[] = [];
  for (const play of plays) {
    if (!play.applied || play.kind !== "plate_result" || play.result !== "single") continue;
    for (const base of [1, 2] as const) {
      const runner = play.before.bases[base - 1];
      if (runner === null || runner === undefined || runner.runnerId !== playerId) continue;
      const moves = play.movements
          .filter((m) => m.runnerId === playerId)
          .sort((a, b) => a.sequence - b.sequence),
        last = moves.at(-1);
      const finalIndex = play.after.bases.findIndex((r) => r?.runnerId === playerId),
        runs =
          play.half === "top"
            ? play.after.awayScore - play.before.awayScore
            : play.after.homeScore - play.before.homeScore;
      const scored = play.movements.filter((m) => m.outcome === "scored").length;
      let outcome: BaserunningOpportunity["outcome"] = "unknown",
        finalBase: number | null = null,
        reason: string | null = null;
      if (play.movements.some((m) => m.reason !== "plate_result")) {
        outcome = "excluded_complex";
        reason = "타격 외 독립 이동이 섞인 플레이";
      } else if (last?.outcome === "out") {
        outcome = "out";
        finalBase = last.toBase;
      } else if (last?.outcome === "scored") {
        if (scored === runs) {
          outcome = "extra_base";
          finalBase = 4;
        } else reason = "득점 취소가 있어 개별 주자의 인정 득점을 확정할 수 없음";
      } else if (finalIndex >= 0) {
        finalBase = finalIndex + 1;
        outcome = finalBase > base + 1 ? "extra_base" : "no_extra_base";
      } else if (last?.outcome === "safe" && play.after.outs === 3) {
        finalBase = last.toBase;
        outcome = finalBase > base + 1 ? "extra_base" : "no_extra_base";
      } else reason = "플레이 이후 주자 위치를 확정할 수 없음";
      result.push({
        gameId: play.gameId,
        revision: play.revision,
        gameDate: play.gameDate,
        playId: play.playId,
        runnerId: playerId,
        fromBase: base,
        outcome,
        finalBase,
        reason,
      });
    }
  }
  return result.sort((a, b) =>
    a.gameDate === b.gameDate
      ? a.gameId === b.gameId
        ? a.playId < b.playId
          ? -1
          : a.playId > b.playId
            ? 1
            : 0
        : a.gameId < b.gameId
          ? -1
          : 1
      : a.gameDate < b.gameDate
        ? -1
        : 1,
  );
}
export function summarizeBaserunningOpportunities(
  rows: readonly BaserunningOpportunity[],
): BaserunningResponse["opportunitySummary"] {
  const count = (outcome: BaserunningOpportunity["outcome"]) =>
    rows.filter((r) => r.outcome === outcome).length;
  const extraBase = count("extra_base"),
    noExtraBase = count("no_extra_base"),
    out = count("out"),
    unknown = count("unknown"),
    excludedComplex = count("excluded_complex"),
    eligible = rows.length - excludedComplex;
  return {
    candidates: rows.length,
    eligible,
    extraBase,
    noExtraBase,
    out,
    unknown,
    excludedComplex,
    extraBaseRate: eligible === 0 || unknown > 0 ? null : extraBase / eligible,
  };
}
