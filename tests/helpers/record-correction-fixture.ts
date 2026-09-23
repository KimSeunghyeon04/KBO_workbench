import { readFile } from "node:fs/promises";

import {
  RecordCorrectionNoticeSchema,
  StagingGameDocumentV2Schema,
  parseStagingGameDocumentV2,
  type RecordCorrectionNotice,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export async function recordCorrectionVenueFixture() {
  return recordCorrectionFixture("venue");
}

export async function recordCorrectionFixture(
  name: "venue" | "missing-double" | "multiple-pitchers" | "pinch-runner-order" | "derived-after",
) {
  return Value.Parse(
    Type.Object(
      { document: StagingGameDocumentV2Schema, notice: RecordCorrectionNoticeSchema },
      { additionalProperties: false },
    ),
    JSON.parse(
      await readFile(`tests/fixtures/correction/record-correction-${name}.anonymized.json`, "utf8"),
    ) as unknown,
  );
}

export const derivedAfterScenarios = [
  "rbi_official_after",
  "rbi_official_before",
  "omitted_double",
  "omitted_double_with_total_bases",
] as const;

export async function recordCorrectionDerivedAfterFixture(
  scenario: (typeof derivedAfterScenarios)[number],
) {
  const source = await recordCorrectionFixture("derived-after");
  const double = scenario === "omitted_double" || scenario === "omitted_double_with_total_bases";
  const document = parseStagingGameDocumentV2({
    ...source.document,
    events: source.document.events.map((event) =>
      double && event.kind === "plate_result"
        ? { ...event, payload: { ...event.payload, result: "double", creditedRbi: 0 } }
        : event,
    ),
    officialRecords: {
      ...source.document.officialRecords,
      batters: source.document.officialRecords.batters.map((record) =>
        double
          ? { ...record, runs: 0, homeRuns: 0, runsBattedIn: 0 }
          : scenario === "rbi_official_before"
            ? { ...record, runsBattedIn: 0 }
            : record,
      ),
    },
  });
  const stats: RecordCorrectionNotice["statChanges"] = double
    ? [
        {
          statIndex: 0,
          participantIndex: 0,
          rawStatName: "2루타",
          statCode: "doubles",
          scope: "batter",
          beforeValue: 1,
          afterValue: 0,
          supportKind: "direct",
        },
      ]
    : source.notice.statChanges;
  if (scenario === "omitted_double_with_total_bases")
    stats.push({
      statIndex: 1,
      participantIndex: 0,
      rawStatName: "루타",
      statCode: "total_bases",
      scope: "batter",
      beforeValue: 2,
      afterValue: 1,
      supportKind: "derived",
    });
  return {
    document,
    notice: {
      ...source.notice,
      contentText: double
        ? `비식별원정\n비식별타자(2루타 1→0${scenario === "omitted_double_with_total_bases" ? ", 루타 2→1" : ""})`
        : source.notice.contentText,
      statChanges: stats,
    },
    binding: {
      eventId: "anon-e2",
      batterPlayerId: "anon-batter",
      pitcherPlayerId: "anon-pitcher",
      participantPlayerIds: { "0": "anon-batter", "1": "anon-pitcher" },
    },
  };
}
