import { canonicalStringify, type OfficialBatterRecord } from "@kbo/contracts";

import type { SourceFinding } from "../types.js";
import { first, integer, type JsonRecord } from "./source-values.js";

type HitKind = "single" | "double" | "triple" | "home_run" | "non_hit";

/** Read the ID-bearing boxscore row; names in etcRecords are not player identities. */
export function enrichNaverOfficialExtraBaseHits(
  row: JsonRecord,
  official: OfficialBatterRecord,
  sourcePath: string,
  rowIndex: number,
): { readonly official: OfficialBatterRecord; readonly findings: readonly SourceFinding[] } {
  const innings = Object.entries(row)
    .filter(([key]) => /^inn[1-9]\d*$/.test(key))
    .sort(([left], [right]) => Number(left.slice(3)) - Number(right.slice(3)));
  if (innings.length === 0) return { official, findings: [] };

  const rawHits = first(row, ["hit", "hits"]);
  const rawHomeRuns = first(row, ["hr", "homeRuns"]);
  const hits = integer(rawHits);
  const homeRuns = integer(rawHomeRuns);
  const sourceText = () =>
    canonicalStringify({
      path: `${sourcePath}[${String(rowIndex)}]`,
      playerId: official.playerId,
      hit: rawHits ?? null,
      hr: rawHomeRuns ?? null,
      doubles: official.doubles ?? null,
      triples: official.triples ?? null,
      innings: Object.fromEntries(innings),
    });
  const unverified = (reason: string) => ({
    official,
    findings: [
      breakdownFinding(
        "source.official_batter.hit_breakdown_unverifiable",
        `${official.playerId}: ${reason} 2루타·3루타를 이닝별 기록으로 보완하지 않았습니다.`,
        sourceText(),
        rowIndex,
      ),
    ],
  });
  if (hits === null || homeRuns === null || hits < 0 || homeRuns < 0) {
    return unverified("명시적인 안타·홈런 합계가 없습니다.");
  }

  const counts = { single: 0, double: 0, triple: 0, home_run: 0, non_hit: 0 };
  for (const [, value] of innings) {
    if (typeof value !== "string") return unverified("이닝별 기록이 문자열이 아닙니다.");
    if (value.trim() === "") continue;
    // Naver uses '/' for multiple plate appearances in the same inning.
    for (const token of value.split("/")) {
      const kind = hitKind(token.trim());
      if (kind === null) return unverified(`해석할 수 없는 이닝별 약호가 있습니다: ${token}`);
      counts[kind] += 1;
    }
  }
  const classifiedHits = counts.single + counts.double + counts.triple + counts.home_run;
  if (classifiedHits + counts.non_hit === 0) {
    if (hits === 0 && homeRuns === 0) return { official, findings: [] };
    return unverified("이닝별 타석 기록이 비어 있습니다.");
  }
  if (classifiedHits !== hits || counts.home_run !== homeRuns) {
    return unverified("이닝별 안타 종류 합계가 명시적인 안타·홈런 합계와 다릅니다.");
  }

  if (
    (official.doubles !== undefined && official.doubles !== counts.double) ||
    (official.triples !== undefined && official.triples !== counts.triple)
  ) {
    return {
      official,
      findings: [
        breakdownFinding(
          "source.official_batter.hit_breakdown_conflict",
          `${official.playerId}: 명시적인 2루타·3루타 합계와 이닝별 기록이 다릅니다. 기존 공식값을 보존했습니다.`,
          sourceText(),
          rowIndex,
        ),
      ],
    };
  }
  // A zero is established by a complete, aggregate-checked breakdown, never by absent fields.
  return {
    official: { ...official, doubles: counts.double, triples: counts.triple },
    findings: [],
  };
}

function hitKind(token: string): HitKind | null {
  // Two locations describe a deflection (e.g. 2중안), not another base-hit count.
  const hit = /^(?:[1-9투포유좌중우]|좌중|우중|[123투포유][123유좌중우])(안|2|3|홈)$/.exec(
    token,
  )?.[1];
  if (hit === "안") return "single";
  if (hit === "2") return "double";
  if (hit === "3") return "triple";
  if (hit === "홈") return "home_run";
  if (
    /^(?:삼진|스낫|4구|고4|사구|야선|타방|삼파|삼번|[1-9투포유좌중우](?:땅|비|직|파|병|실|희번|희비|번|희실|희선|삼중)|[123투포유][123유]병)$/.test(
      token,
    )
  ) {
    return "non_hit";
  }
  return null;
}

function breakdownFinding(
  code: string,
  message: string,
  sourceText: string,
  rowIndex: number,
): SourceFinding {
  return {
    lifecycle: "persistent",
    code,
    severity: "warning",
    endpoint: "record",
    rowIndex,
    sourceText,
    message,
  };
}
