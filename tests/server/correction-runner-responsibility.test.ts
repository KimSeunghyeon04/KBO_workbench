import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { CorrectionEventContextSchema, parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { describe, expect, it } from "vitest";
import { prepareCorrectionSnapshot } from "../../apps/server/src/correction-snapshot.js";

const document = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile(
      "tests/fixtures/correction/force-double-play-responsibility.anonymized.json",
      "utf8",
    ),
  ) as unknown,
);

describe("보정 작업 사본의 책임 투수 표시", () => {
  it("현재 투수가 아닌 compiler 이동의 최종 책임을 source 행에 연결한다", () => {
    const replay = compileStagingGameDocumentV2(document);
    const snapshot = prepareCorrectionSnapshot(document, replay, []);
    const movement = document.events.find(
      (event) =>
        event.kind === "runner_advance" &&
        event.payload.runnerId === "h3" &&
        event.payload.toBase === 2,
    );
    if (movement === undefined) throw new Error("missing anonymous runner");
    const context = snapshot.eventContexts.find(
      (context) => context.eventId === movement.identity.eventId,
    );
    expect(context?.runnerMovement).toEqual({ runnerId: "h3", responsiblePitcherId: "a1" });
    expect(context?.before.pitcherId).toBe("a51");
    for (const context of snapshot.eventContexts)
      expect(Value.Check(CorrectionEventContextSchema, context)).toBe(true);
    expect(
      snapshot.eventContexts.find(
        (context) =>
          document.events.find((event) => event.identity.eventId === context.eventId)?.kind ===
          "pitch",
      )?.runnerMovement,
    ).toBeUndefined();
    expect(
      Value.Check(CorrectionEventContextSchema, {
        ...context,
        runnerMovement: { runnerId: "h3", responsiblePitcherId: "a1", guessed: true },
      }),
    ).toBe(false);
  });
});
