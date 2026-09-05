import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildNaverPitchMetadataEnrichment, mapNaverGame } from "@kbo/collection";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { parseNaverPitchMetadata } from "../../packages/collection/src/naver/pitch-metadata.js";
import { metadataBundle, stripMetadata } from "../helpers/pitch-metadata.js";

const source = {
  endpoint: "relay_001",
  blockIndex: 2,
  rowIndex: 3,
  eventId: "event",
  sourceText: "1구 볼",
};

describe("원천 투구 구속·구종", () => {
  it("저장 원문 비식별 사례의 제공 명칭을 그대로 보존한다", async () => {
    const fixture = JSON.parse(
      await readFile("tests/fixtures/naver/pitch-metadata.anonymized.json", "utf8"),
    ) as { observed: { speed: string; stuff: string }[] };
    for (const row of fixture.observed)
      expect(parseNaverPitchMetadata(row.speed, row.stuff, source)).toEqual({
        metadata: { speedKph: Number(row.speed), pitchType: row.stuff },
        findings: [],
      });
  });
  it.each([144, "144", " 144.5 "])("숫자·문자열 구속을 유한 양수로 해석한다: %s", (speed) => {
    expect(parseNaverPitchMetadata(speed, "체인지업", source).metadata).toEqual({
      speedKph: Number(speed),
      pitchType: "체인지업",
    });
  });
  it.each([0, -1, NaN, Infinity, "NaN", "Infinity", "145km/h", {}, true])(
    "잘못된 구속은 위치 warning으로 남긴다: %s",
    (speed) => {
      const parsed = parseNaverPitchMetadata(speed, "직구", source);
      expect(parsed.metadata).toEqual({ pitchType: "직구" });
      expect(parsed.findings).toEqual([
        expect.objectContaining({
          ...source,
          code: "source.pitch_metadata.invalid_speed",
          severity: "warning",
        }),
      ]);
    },
  );
  it("빈 값은 미제공이고 잘못된 구종 타입은 warning이다", () => {
    for (const value of [undefined, null, "", "  "])
      expect(parseNaverPitchMetadata(value, value, source)).toEqual({ metadata: {}, findings: [] });
    expect(parseNaverPitchMetadata(140, 9, source).findings[0]?.code).toBe(
      "source.pitch_metadata.invalid_stuff",
    );
  });
  it("좌표·pitch ID가 없어도 행 metadata를 compiler fact에 전달한다", async () => {
    const mapped = mapNaverGame(await metadataBundle());
    expect(mapped.document.trackingCandidates).toHaveLength(0);
    const pitches = mapped.document.events.filter((event) => event.kind === "pitch");
    expect(pitches[0]?.payload).toMatchObject({ speedKph: 133, pitchType: "포크" });
    expect(pitches[0]?.payload).not.toHaveProperty("sourcePitchId");
    expect(compileStagingGameDocumentV2(mapped.document).pitchFacts[0]).toMatchObject({
      speedKph: 133,
      pitchType: "포크",
    });
    for (const speedKph of [0, -1, Infinity, "144"]) {
      expect(() =>
        parseStagingGameDocumentV2({
          ...mapped.document,
          events: mapped.document.events.map((event) =>
            event.kind === "pitch" ? { ...event, payload: { ...event.payload, speedKph } } : event,
          ),
        }),
      ).toThrow();
    }
  });
  it("현재 원장의 누락 값만 채우고 재실행·삭제·재정렬·수동 값을 보존한다", async () => {
    const bundle = await metadataBundle();
    const full = mapNaverGame(bundle).document;
    const original = stripMetadata(full);
    const first = buildNaverPitchMetadataEnrichment(original, bundle);
    expect(first.replacements).toHaveLength(1);
    expect(buildNaverPitchMetadataEnrichment(full, bundle).replacements).toHaveLength(0);
    const reordered = parseStagingGameDocumentV2({
      ...original,
      events: [...original.events].reverse().map((event, sequence) => ({ ...event, sequence })),
    });
    expect(buildNaverPitchMetadataEnrichment(reordered, bundle).replacements[0]?.payload).toEqual(
      first.replacements[0]?.payload,
    );
    const removed = parseStagingGameDocumentV2({
      ...original,
      events: original.events
        .filter((event) => event.kind !== "pitch")
        .map((event, sequence) => ({ ...event, sequence })),
    });
    expect(buildNaverPitchMetadataEnrichment(removed, bundle).replacements).toHaveLength(0);
    const conflict = parseStagingGameDocumentV2({
      ...original,
      events: original.events.map((event) =>
        event.kind === "pitch" ? { ...event, payload: { ...event.payload, speedKph: 150 } } : event,
      ),
    });
    const enriched = buildNaverPitchMetadataEnrichment(conflict, bundle);
    expect(enriched.replacements[0]?.payload).toMatchObject({ speedKph: 150, pitchType: "포크" });
    expect(enriched.issues[0]).toMatchObject({ reason: "value_conflict", field: "speedKph" });
    const manual = parseStagingGameDocumentV2({
      ...original,
      events: original.events.map((event) =>
        event.kind === "pitch"
          ? {
              ...event,
              identity: { kind: "manual", eventId: "0198f47a-1234-7abc-8def-1234567890ab" },
            }
          : event,
      ),
    });
    expect(buildNaverPitchMetadataEnrichment(manual, bundle).issues[0]?.reason).toBe("manual");
  });

  it("반복·누락된 pitch ID의 구속·구종은 각각의 원천 투구 행에 귀속된다", async () => {
    const bundle = await metadataBundle([
      { text: "1구 볼", ptsPitchId: "reused", speed: "144", stuff: "직구" },
      { text: "2구 스트라이크", ptsPitchId: "reused", speed: 122, stuff: "커브" },
      { text: "3구 볼", speed: "133", stuff: "포크" },
    ]);
    const mapped = mapNaverGame(bundle);
    const metadata = (events: typeof mapped.document.events) =>
      events
        .filter((event) => event.kind === "pitch")
        .map((event) => ({ speed: event.payload.speedKph, type: event.payload.pitchType }));
    const expected = [
      { speed: 144, type: "직구" },
      { speed: 122, type: "커브" },
      { speed: 133, type: "포크" },
    ];
    expect(metadata(mapped.document.events)).toEqual(expected);
    const enrichment = buildNaverPitchMetadataEnrichment(stripMetadata(mapped.document), bundle);
    expect(metadata([...enrichment.replacements])).toEqual(expected);
  });
  it("hash 또는 원천 위치 문맥이 어긋나면 추측하지 않는다", async () => {
    const bundle = await metadataBundle();
    const document = stripMetadata(mapNaverGame(bundle).document);
    expect(() =>
      buildNaverPitchMetadataEnrichment(
        { ...document, source: { ...document.source, sourceBundleHash: "0".repeat(64) } },
        bundle,
      ),
    ).toThrow(/hash/);
    const wrong = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.kind === "pitch" ? { ...event, inning: event.inning + 1 } : event,
      ),
    });
    expect(buildNaverPitchMetadataEnrichment(wrong, bundle).issues[0]?.reason).toBe(
      "source_mismatch",
    );
  });
});
