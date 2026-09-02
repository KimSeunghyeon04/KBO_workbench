import type { CorrectionFinding } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import { buildDisplayFindings } from "../../apps/web/src/correction/finding-presentation";

describe("correction finding presentation", () => {
  it("기본 목록은 현재 finding만 표시하고 저장 당시 동일 문제와 연결한다", () => {
    const storedMismatch = finding("source_observation_mismatch", "e1", []);
    const resolvedStored = finding("pitch_after_terminal_count", "e2", []);
    const currentMismatch = finding("source_observation_mismatch", "e1", [
      { field: "strikes", expected: 1, actual: 2 },
    ]);
    const currentOnly = finding("plate_appearance_overlap", "e3", []);

    const displayed = buildDisplayFindings(
      {
        storedFindings: [storedMismatch, resolvedStored],
        findings: [currentMismatch, currentOnly],
      },
      false,
    );

    expect(displayed).toEqual([
      { ...currentOnly, origin: "current" },
      { ...currentMismatch, origin: "both" },
    ]);
  });

  it("요청할 때만 현재 재검증에서 사라진 수집 당시 finding을 덧붙인다", () => {
    const stillCurrent = finding("source_observation_mismatch", "e1", [
      { field: "strikes", expected: 1, actual: 2 },
    ]);
    const storedCopy = finding("source_observation_mismatch", "e1", []);
    const storedOnly = finding("source.pitch_unresolved", undefined, [
      { field: "endpoint", actual: "relay_004" },
    ]);

    const displayed = buildDisplayFindings(
      { storedFindings: [storedCopy, storedOnly], findings: [stillCurrent] },
      true,
    );

    expect(displayed).toEqual([
      { ...storedOnly, origin: "stored" },
      { ...stillCurrent, origin: "both" },
    ]);
  });

  it("같은 경기 단위 코드라도 현재 record별 finding은 합치지 않는다", () => {
    const stored = {
      ...finding("official_record_mismatch", undefined, []),
      recordIdentity: "a",
    };
    const first = { ...finding("official_record_mismatch", undefined, []), recordIdentity: "a" };
    const second = { ...finding("official_record_mismatch", undefined, []), recordIdentity: "b" };

    const displayed = buildDisplayFindings(
      { storedFindings: [stored], findings: [first, second] },
      false,
    );

    expect(displayed).toEqual([
      { ...first, origin: "both" },
      { ...second, origin: "current" },
    ]);
  });
});

function finding(
  code: string,
  eventId: string | undefined,
  details: CorrectionFinding["details"],
): CorrectionFinding {
  return {
    code,
    category: "source",
    severity: "blocking",
    message: `${code} message`,
    gameId: "20240724WOOB02024",
    ...(eventId === undefined ? {} : { eventId }),
    details,
  };
}
