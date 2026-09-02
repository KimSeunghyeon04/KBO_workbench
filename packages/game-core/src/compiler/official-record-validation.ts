import type { CompileContext, MutableBatterLine, MutablePitcherLine } from "./model.js";
export function compareOfficialRecords(context: CompileContext): void {
  for (const official of context.document.officialRecords.batters) {
    const calculated = context.batterLines.get(official.playerId);
    if (calculated === undefined) continue;
    for (const [field, expected] of Object.entries(official)) {
      if (["playerId", "side"].includes(field) || expected === undefined) continue;
      const actual = calculated[field as keyof MutableBatterLine];
      if (
        field === "runsBattedIn" &&
        context.uncertainRbiBatterIds.has(official.playerId) &&
        typeof actual === "number" &&
        actual !== expected
      ) {
        context.findings.push({
          code: "official_rbi_not_verifiable",
          category: "source",
          severity: "warning",
          message: "득점 플레이에 명시적인 타점 판정이 없어 공식 타점을 검증할 수 없습니다.",
          gameId: context.document.metadata.gameId,
          recordIdentity: `batter:${official.playerId}`,
          details: [{ field, expected: expected as number, actual }],
        });
        continue;
      }
      if (typeof actual === "number" && actual !== expected) {
        context.findings.push({
          code: "official_batter_record_mismatch",
          category: "domain",
          severity: "blocking",
          message: "공식 타자 기록과 compiler 계산 기록이 다릅니다.",
          gameId: context.document.metadata.gameId,
          recordIdentity: `batter:${official.playerId}`,
          details: [{ field, expected: expected as number, actual }],
        });
      }
    }
  }
  for (const official of context.document.officialRecords.pitchers) {
    const calculated = context.pitcherLines.get(official.playerId);
    if (calculated === undefined) continue;
    for (const [field, expected] of Object.entries(official)) {
      if (["playerId", "side", "earnedRuns"].includes(field) || expected === undefined) continue;
      const actual = calculated[field as keyof MutablePitcherLine];
      if (typeof actual === "number" && actual !== expected) {
        context.findings.push({
          code: "official_pitcher_record_mismatch",
          category: "domain",
          severity: "blocking",
          message: "공식 투수 기록과 compiler 계산 기록이 다릅니다.",
          gameId: context.document.metadata.gameId,
          recordIdentity: `pitcher:${official.playerId}`,
          details: [{ field, expected: expected as number, actual }],
        });
      }
    }
  }
}
