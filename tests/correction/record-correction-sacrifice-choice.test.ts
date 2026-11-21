import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { RecordCorrectionNoticeSchema, StagingGameDocumentV2Schema } from "@kbo/contracts";
import { applyCorrectionCommand, buildRecordCorrectionBatchProposal } from "@kbo/correction";

const fixture = Value.Parse(
  Type.Object({ document: StagingGameDocumentV2Schema, notice: RecordCorrectionNoticeSchema }),
  JSON.parse(
    await readFile(
      "tests/fixtures/correction/record-correction-stale-revision.anonymized.json",
      "utf8",
    ),
  ) as unknown,
);
const binding = {
  eventId: "anonymous-revision-source:relay_007:4:6",
  batterPlayerId: "home-player-2",
  pitcherPlayerId: "away-player-21",
  participantPlayerIds: Object.fromEntries(
    fixture.notice.participants.map((participant) => [
      participant.participantIndex,
      participant.role === "batter" ? "home-player-2" : "away-player-21",
    ]),
  ),
};
const document = {
  ...fixture.document,
  officialRecords: {
    ...fixture.document.officialRecords,
    batters: fixture.document.officialRecords.batters.map((record) => {
      if (record.playerId !== binding.batterPlayerId) return record;
      const copy = { ...record };
      delete copy.sacrificeBunts;
      return copy;
    }),
  },
};

describe("희생번트 출루 정정", () => {
  it.each(["fielder_choice", "error"] as const)(
    "%s 공지의 희생번트 출루를 보존하고 빠진 희타 계수만 반영한다",
    (decisionAfter) => {
      const notice = { ...fixture.notice, decisionAfter };
      const proposal = buildRecordCorrectionBatchProposal(document, notice, binding);
      expect(proposal.reasons).toEqual([]);
      expect(proposal.eligible).toBe(true);
      expect(proposal.batch?.commands).toEqual([
        expect.objectContaining({
          kind: "update_official_record",
          playerId: binding.batterPlayerId,
          record: expect.objectContaining({ sacrificeBunts: 1 }),
        }),
      ]);
      if (proposal.batch === null) throw new Error("희생번트 정정 batch가 없습니다.");
      const applied = applyCorrectionCommand(document, proposal.batch);
      expect(applied.document.events).toEqual(document.events);
      const check = buildRecordCorrectionBatchProposal(applied.document, notice, binding);
      expect(check.reasons).toEqual([]);
      expect(check.batch).toBeNull();
    },
  );
});
