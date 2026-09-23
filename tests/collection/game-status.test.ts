import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import { mapNaverGame, type RawGameBundle } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { sanitizedNaverBundle } from "../helpers/naver.js";

const statusEvidenceSchema = Type.Object({
  gameInfo: Type.Record(Type.String(), Type.Unknown()),
  relaySummary: Type.Object({
    result: Type.Object({
      textRelayData: Type.Object({
        inn: Type.Integer(),
        homeOrAway: Type.String(),
        textRelays: Type.Array(
          Type.Object({
            no: Type.Integer(),
            textOptions: Type.Array(
              Type.Object({
                seqno: Type.Integer(),
                type: Type.Integer(),
                text: Type.String(),
                currentGameState: Type.Object({
                  out: Type.String(),
                  awayScore: Type.String(),
                  homeScore: Type.String(),
                }),
              }),
            ),
          }),
        ),
      }),
    }),
  }),
});

async function sourceEvidence() {
  // Reduced from a completed game's preview and final relay. IDs, names and date
  // are anonymized; status, footer, row order and terminal observations are retained.
  return Value.Decode(
    statusEvidenceSchema,
    JSON.parse(await readFile("tests/fixtures/naver/status-four-final.anonymized.json", "utf8")),
  );
}

async function withEvidence(
  evidence: Awaited<ReturnType<typeof sourceEvidence>>,
): Promise<RawGameBundle> {
  const bundle = await sanitizedNaverBundle();
  const lineup = Value.Decode(Type.Record(Type.String(), Type.Unknown()), bundle.payloads.lineup);
  const { game_info: unused, ...rosters } = lineup;
  void unused;
  return {
    ...bundle,
    payloads: {
      ...bundle.payloads,
      lineup: { result: { previewData: { ...rosters, gameInfo: evidence.gameInfo } } },
      relay_summary: evidence.relaySummary,
    },
  };
}

it.each(["4", 4])(
  "accepts status %s only with the preserved final relay evidence",
  async (status) => {
    const evidence = await sourceEvidence();
    evidence.gameInfo.statusCode = status;
    const bundle = await withEvidence(evidence);
    const mapped = mapNaverGame(bundle);
    expect(mapped.document.metadata.status).toBe("final");
    expect(mapNaverGame(bundle)).toEqual(mapped);
    evidence.gameInfo.statusCode = "RESULT";
    const explicit = mapNaverGame(await withEvidence(evidence));
    expect(mapped.document.events).toEqual(explicit.document.events);
    expect(mapped.document.officialRecords).toEqual(explicit.document.officialRecords);
    expect(mapped.document.trackingCandidates).toEqual(explicit.document.trackingCandidates);
    // Recognizing the final state must not bypass the compiler's record checks.
    const inconsistent = structuredClone(mapped.document);
    const batter = inconsistent.officialRecords.batters[0];
    if (batter === undefined) throw new Error("Missing fixture batter");
    batter.hits = 99;
    expect(
      compileStagingGameDocumentV2(inconsistent).findings.some(
        (finding) =>
          finding.code === "official_batter_record_mismatch" && finding.severity === "blocking",
      ),
    ).toBe(true);
  },
);

it.each(["missing summary", "missing footer", "not terminal", "wrong row type"])(
  "rejects status 4 with %s instead of inferring a completed game",
  async (failure) => {
    const evidence = await sourceEvidence();
    for (const block of evidence.relaySummary.result.textRelayData.textRelays) {
      for (const row of block.textOptions) {
        if (failure === "missing footer") row.text = "=====================================";
        if (failure === "not terminal") row.currentGameState.out = "2";
        if (failure === "wrong row type") row.type = 1;
      }
    }
    const bundle = await withEvidence(evidence);
    const { relay_summary: summary, ...withoutSummary } = bundle.payloads;
    void summary;
    expect(() =>
      mapNaverGame(
        failure === "missing summary" ? { ...bundle, payloads: withoutSummary } : bundle,
      ),
    ).toThrow("알 수 없는 경기 상태입니다: 4");
  },
);

it.each([
  ["CANCELLED", "cancelled"],
  ["LIVE", "in_progress"],
  ["SUSPENDED", "suspended"],
])(
  "keeps the explicit %s status even when a terminal footer is present",
  async (status, expected) => {
    const evidence = await sourceEvidence();
    evidence.gameInfo.statusCode = status;
    expect(mapNaverGame(await withEvidence(evidence)).document.metadata.status).toBe(expected);
  },
);

it("does not generalize the legacy exception to arbitrary numeric statuses", async () => {
  const evidence = await sourceEvidence();
  evidence.gameInfo.statusCode = "42";
  const bundle = await withEvidence(evidence);
  expect(() => mapNaverGame(bundle)).toThrow("알 수 없는 경기 상태입니다: 42");
});
