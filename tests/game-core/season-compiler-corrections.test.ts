import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

const continuations = Value.Decode(
  Type.Record(Type.String(), Type.Unknown()),
  JSON.parse(
    await readFile(
      "tests/fixtures/correction/continued-pa-after-substitution.anonymized.json",
      "utf8",
    ),
  ) as unknown,
);
const extraAdvance = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile(
      "tests/fixtures/correction/fielder-choice-extra-advance-out.anonymized.json",
      "utf8",
    ),
  ) as unknown,
);

describe("시즌 중계의 타석 계속과 추가 진루 책임", () => {
  it.each(["pitcher", "runner", "fielder"])(
    "%s 교체 뒤 같은 타자 표시는 투구와 카운트를 이어간다",
    (role) => {
      const document = parseStagingGameDocumentV2(continuations[role]);
      const replay = compileStagingGameDocumentV2(document);
      expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
      const header = document.events.find(
        (event, index) =>
          event.kind === "batter_start" && document.events[index - 1]?.kind === "substitution",
      );
      const frame = replay.frames.find((item) => item.eventId === header?.identity.eventId);
      expect(frame?.after.balls).toBe(role === "pitcher" ? 1 : 0);
      expect(frame?.after.strikes).toBe(role === "runner" ? 2 : role === "fielder" ? 1 : 0);
      expect(replay.pitchFacts).toHaveLength(role === "runner" ? 3 : 4);
      expect(replay.plateAppearances).toHaveLength(role === "runner" ? 2 : 1);
      expect(replay.plateAppearances.at(-1)).toMatchObject({ result: "strikeout" });
      expect(replay).toEqual(compileStagingGameDocumentV2(document));
    },
  );

  it("교체가 없거나 다른 타자·투수인 헤더는 진행 중 타석과 합치지 않는다", () => {
    const document = parseStagingGameDocumentV2(continuations["fielder"]);
    for (const mode of ["no_substitution", "other_batter", "other_pitcher"]) {
      const altered = {
        ...document,
        events: document.events
          .filter((event) => mode !== "no_substitution" || event.kind !== "substitution")
          .map((event, sequence) => ({
            ...event,
            sequence,
            ...(event.kind === "batter_start" && event.identity.eventId === "e4"
              ? {
                  payload: {
                    batterId: mode === "other_batter" ? "a2" : event.payload.batterId,
                    pitcherId: mode === "other_pitcher" ? "hp2" : event.payload.pitcherId,
                  },
                }
              : {}),
          })),
      };
      expect(
        compileStagingGameDocumentV2(altered).findings.map((finding) => finding.code),
      ).toContain("plate_appearance_overlap");
    }
  });

  it.each([false, true])(
    "추가 진루 중 태그아웃의 책임은 소멸한다 (중간 진루 생략: %s)",
    (compact) => {
      const document = {
        ...extraAdvance,
        events: extraAdvance.events
          .filter(
            (event) =>
              !(
                compact &&
                event.kind === "runner_advance" &&
                event.payload.runnerId === "a2" &&
                event.payload.outcome === "safe"
              ),
          )
          .map((event, sequence) => ({
            ...event,
            sequence,
            ...(compact &&
            event.kind === "runner_advance" &&
            event.payload.runnerId === "a2" &&
            event.payload.outcome === "out"
              ? { payload: { ...event.payload, fromBase: 1 } }
              : {}),
          })),
      };
      const replay = compileStagingGameDocumentV2(document);
      expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
      const choice = replay.plays.find((play) =>
        play.movements.some((move) => move.runnerId === "a2" && move.outcome === "out"),
      );
      expect(choice?.after.bases).toEqual([
        null,
        { runnerId: "a3", responsiblePitcherId: "hp2" },
        null,
      ]);
      expect(replay.pitcherLines.find((line) => line.playerId === "hp1")?.runs).toBe(1);
      expect(replay.pitcherLines.find((line) => line.playerId === "hp2")?.runs).toBe(2);
    },
  );
});
