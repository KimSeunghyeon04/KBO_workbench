import { readFile } from "node:fs/promises";

import { RecordCorrectionNoticeSchema, StagingGameDocumentV2Schema } from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export async function recordCorrectionVenueFixture() {
  return recordCorrectionFixture("venue");
}

export async function recordCorrectionFixture(
  name: "venue" | "missing-double" | "multiple-pitchers" | "pinch-runner-order",
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
