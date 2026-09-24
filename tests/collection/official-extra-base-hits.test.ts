import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { mapNaverGame, type RawGameBundle } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { sanitizedNaverBundle } from "../helpers/naver.js";

const cases = Value.Decode(
  Type.Array(
    Type.Object({
      case: Type.String(),
      relayResult: Type.Union([
        Type.Literal("single"),
        Type.Literal("double"),
        Type.Literal("triple"),
      ]),
      relayText: Type.String(),
      row: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
      etcRecords: Type.Array(Type.Object({ how: Type.String(), result: Type.String() })),
      doubles: Type.Number(),
      triples: Type.Number(),
      mismatchField: Type.Union([Type.Literal("doubles"), Type.Literal("triples")]),
    }),
  ),
  JSON.parse(
    await readFile("tests/fixtures/naver/extra-base-hit-conflicts.anonymized.json", "utf8"),
  ) as unknown,
);

describe("Naver official extra-base hit evidence", () => {
  it.each(cases)("detects $case without rewriting relay evidence", async (fixture) => {
    const bundle = await bundleWithRow(fixture.row, fixture.etcRecords);
    const rawRelay = JSON.stringify(bundle.payloads.relay_001);
    const relay = Value.Decode(
      Type.Object({
        result: Type.Object({
          textRelayData: Type.Object({
            textRelays: Type.Array(
              Type.Object({ textOptions: Type.Array(Type.Record(Type.String(), Type.Unknown())) }),
            ),
          }),
        }),
      }),
      bundle.payloads.relay_001,
    );
    const row = relay.result.textRelayData.textRelays[0]?.textOptions[3];
    if (row === undefined) throw new Error("missing fixture result");
    row.result = fixture.relayResult;
    row.text = fixture.relayText;
    const fixtureBundle = {
      ...bundle,
      payloads: { ...bundle.payloads, relay_001: relay },
    };
    const raw = JSON.stringify(fixtureBundle);
    const mapped = mapNaverGame(fixtureBundle);

    expect(mapped.findings).toEqual([]);
    expect(mapped.document.officialRecords.batters[0]).toMatchObject({
      doubles: fixture.doubles,
      triples: fixture.triples,
    });
    expect(mapped.document.events.find((event) => event.kind === "plate_result")).toMatchObject({
      payload: { result: fixture.relayResult },
      relayText: fixture.relayText,
    });
    expect(JSON.stringify(fixtureBundle)).toBe(raw);
    expect(rawRelay).not.toBe(JSON.stringify(fixtureBundle.payloads.relay_001));
    const compiled = compileStagingGameDocumentV2(mapped.document);
    expect(compiled.findings).toContainEqual(
      expect.objectContaining({
        code: "official_batter_record_mismatch",
        severity: "blocking",
        recordIdentity: "batter:A1",
        details: [expect.objectContaining({ field: fixture.mismatchField })],
      }),
    );
  });

  it("counts slash-separated at-bats and exact fielder prefixes without treating groundouts as hits", async () => {
    const mapped = mapNaverGame(
      await bundleWithRow({
        hit: 5,
        hr: 1,
        inn1: "우홈/삼진",
        inn3: "3안/우중2",
        inn5: "투3안/중3",
        inn7: "2땅",
      }),
    );
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.officialRecords.batters[0]).toMatchObject({ doubles: 1, triples: 1 });
  });

  it("establishes zero only from a complete aggregate-checked breakdown", async () => {
    const mapped = mapNaverGame(await bundleWithRow({ hit: 1, hr: 0, inn1: "중안", inn2: "" }));
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.officialRecords.batters[0]).toMatchObject({ doubles: 0, triples: 0 });
  });

  it.each([
    { hit: 2, hr: 0, inn1: "중안" },
    { hit: 1, hr: 1, inn1: "우중2" },
    { hit: 1, hr: 0, inn1: "우중2", inn2: "미확인" },
    { hit: 1, hr: 0, inn1: "우중2/" },
    { hit: 1, hr: 0, inn1: "우중2 안타" },
    { hit: 1, hr: 0, inn1: "우중2,삼진" },
    { hit: 1, hr: 0, inn1: 2 },
    { hit: 1, hr: 0, inn1: "" },
    { hit: 0, hr: 1, inn1: "" },
    { hit: 1, hr: 0, inn1: "/우안" },
    { hit: null, hr: 0, inn1: "중안" },
    { hit: 1, hr: null, inn1: "중안" },
  ])("preserves incomplete or ambiguous evidence %j without invented totals", async (row) => {
    const mapped = mapNaverGame(await bundleWithRow(row));
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("doubles");
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("triples");
    expect(mapped.findings).toEqual([
      expect.objectContaining({
        code: "source.official_batter.hit_breakdown_unverifiable",
        severity: "warning",
        lifecycle: "persistent",
        endpoint: "record",
        rowIndex: 0,
      }),
    ]);
    const source = JSON.parse(mapped.findings[0]?.sourceText ?? "null") as unknown;
    expect(source).toMatchObject({ path: "batter.away[0]", playerId: "A1" });
  });

  it("does not turn absent innings or an ambiguous name-only summary into zero", async () => {
    const mapped = mapNaverGame(
      await bundleWithRow({}, [{ how: "2루타", result: "원정 타자(1회)" }]),
    );
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("doubles");
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("triples");
  });

  it("silently omits absent plate appearances only when explicit hit and home-run totals are zero", async () => {
    const mapped = mapNaverGame(await bundleWithRow({ hit: 0, hr: 0, inn1: "", inn2: " " }));
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("doubles");
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("triples");
  });

  it.each([
    ["야선", 0, 0, 0],
    ["투번", 0, 0, 0],
    ["3번", 0, 0, 0],
    ["투희실", 0, 0, 0],
    ["좌희실", 0, 0, 0],
    ["포희선", 0, 0, 0],
    ["3삼중", 0, 0, 0],
    ["타방", 0, 0, 0],
    ["삼파", 0, 0, 0],
    ["삼번", 0, 0, 0],
    ["유2병", 0, 0, 0],
    ["1유병", 0, 0, 0],
    ["2중안", 1, 0, 0],
    ["1우안", 1, 0, 0],
    ["3유안", 1, 0, 0],
    ["12안", 1, 0, 0],
    ["투좌안", 1, 0, 0],
    ["유3안", 1, 0, 0],
    ["32", 1, 1, 0],
    ["12", 1, 1, 0],
    ["투2", 1, 1, 0],
    ["1우2", 1, 1, 0],
    ["2중2", 1, 1, 0],
    ["3유2", 1, 1, 0],
    ["유우2", 1, 1, 0],
    ["1우3", 1, 0, 1],
  ])("recognizes source-confirmed notation %s", async (token, hits, doubles, triples) => {
    const mapped = mapNaverGame(await bundleWithRow({ hit: hits, hr: 0, inn1: token }));
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.officialRecords.batters[0]).toMatchObject({ doubles, triples });
  });

  it("retains conflicting explicit fields and source evidence instead of selecting a winner", async () => {
    const mapped = mapNaverGame(await bundleWithRow({ hit: 1, hr: 0, h2: 0, inn1: "우중2" }));
    expect(mapped.document.officialRecords.batters[0]).toMatchObject({ doubles: 0 });
    expect(mapped.document.officialRecords.batters[0]).not.toHaveProperty("triples");
    expect(mapped.findings[0]).toMatchObject({
      code: "source.official_batter.hit_breakdown_conflict",
      severity: "warning",
      endpoint: "record",
    });
  });

  it("keeps matching explicit totals and is independent of source object key order", async () => {
    const row = { hit: 2, hr: 0, h2: 1, h3: 1, inn2: "좌2", inn1: "중3" };
    const first = mapNaverGame(await bundleWithRow(row));
    const second = mapNaverGame(
      await bundleWithRow(Object.fromEntries(Object.entries(row).reverse())),
    );
    expect(first).toEqual(second);
    expect(first.findings).toEqual([]);
    expect(first.document.officialRecords.batters[0]).toMatchObject({ doubles: 1, triples: 1 });
  });
});

async function bundleWithRow(
  row: Readonly<Record<string, unknown>>,
  etcRecords: readonly unknown[] = [],
): Promise<RawGameBundle> {
  const bundle = await sanitizedNaverBundle();
  return {
    ...bundle,
    payloads: {
      ...bundle.payloads,
      record: {
        batter: {
          away: [{ playerCode: "A1", ab: 1, bb: 0, hit: 1, hr: 0, kk: 0, rbi: 0, run: 0, ...row }],
          home: [],
        },
        pitcher: { away: [], home: [] },
        etcRecords,
      },
    },
  };
}
