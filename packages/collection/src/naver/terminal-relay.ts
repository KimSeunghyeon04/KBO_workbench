import { administrativeCode, kindDecision, pitchCallDecision } from "./lexicon.js";
import type { CanonicalNaverRow } from "./model.js";

/** 종료 선언 뒤의 완전히 일치하는 재전송만 분류한다. 행과 원문 위치는 삭제하지 않는다. */
export function classifyTerminalRelay(
  rows: readonly CanonicalNaverRow[],
): ReadonlyMap<CanonicalNaverRow, string> {
  const result = new Map<CanonicalNaverRow, string>();
  const kindOf = (row: CanonicalNaverRow) => {
    const decision = kindDecision(row);
    return decision.status === "matched" ? decision.value : "unresolved";
  };
  for (const [index, marker] of rows.entries()) {
    if (
      kindOf(marker) !== "administrative" ||
      !["footer", "called_game"].includes(administrativeCode(marker))
    )
      continue;
    const suffix = rows
      .slice(index + 1)
      .filter((row) => !["administrative", "review"].includes(kindOf(row)));
    if (suffix.length === 0) continue;
    if (
      administrativeCode(marker) === "called_game" &&
      suffix.every((row) =>
        ["half_inning_start", "batter_start", "substitution"].includes(kindOf(row)),
      )
    ) {
      for (const row of suffix)
        result.set(
          row,
          "콜드게임 종료 선언 뒤 실제 투구·결과·주자 이동이 없는 이닝·타자·교체 표시를 안내 행으로 보존했습니다.",
        );
      break;
    }
    if (suffix.every((row) => kindOf(row) === "batter_start")) {
      for (const row of suffix)
        result.set(row, "종료 선언 뒤 실제 투구·결과가 없는 타자 표시를 안내 행으로 보존했습니다.");
      break;
    }
    if (suffix.some((row) => row.inning !== marker.inning || row.half !== marker.half)) continue;
    if (
      kindOf(suffix[0] ?? marker) !== "batter_start" ||
      suffix.some((row) => kindOf(row) === "half_inning_start")
    )
      continue;
    const pitches = suffix.filter((row) => {
      if (kindOf(row) !== "pitch") return false;
      const call = pitchCallDecision(row);
      return (
        call.status !== "matched" ||
        !["no_pitch", "automatic_ball", "automatic_strike"].includes(call.value)
      );
    });
    if (
      pitches.length === 0 ||
      pitches.some((row) => row.sourcePitchId === null) ||
      !suffix.some((row) => kindOf(row) === "plate_result")
    )
      continue;
    const prior = rows
      .slice(0, index)
      .filter((row) => !["administrative", "review"].includes(kindOf(row)));
    const matches = prior.filter(
      (first, start) =>
        first.inning === marker.inning &&
        first.half === marker.half &&
        suffix.every(
          (row, offset) => prior[start + offset]?.semanticFingerprint === row.semanticFingerprint,
        ),
    );
    if (matches.length !== 1) continue;
    const original = matches[0];
    if (original === undefined) continue;
    const note = `종료 선언 뒤 ${String(suffix.length)}개 행이 ${original.source.endpoint} block ${String(original.source.endpointBlockIndex)} row ${String(original.rawIndex)}부터의 중계와 완전히 일치하여 안내 행으로 보존했습니다.`;
    for (const row of suffix) result.set(row, note);
    break;
  }
  return result;
}
