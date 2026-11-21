import { readFile } from "node:fs/promises";
import { Client, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { buildRelationalProjection, PROJECTION_TABLE_DESCRIPTORS } from "@kbo/persistence";
import {
  readProjection,
  writeProjection,
} from "../../packages/persistence/src/projection-repository.js";

describe("projection INSERT batching", () => {
  it.each([3, 4] as const)(
    "reads empty version %s tables with independent row arrays",
    async (version) => {
      const client = Object.assign(new Client(), { release: vi.fn() });
      const query = vi.spyOn(client, "query").mockResolvedValue({
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
      const tables = await readProjection(client, "fixture", 1, version);
      expect(Object.keys(tables)).toHaveLength(30);
      expect(tables).toMatchObject({
        relay_event_facts: [],
        pitch_facts: [],
        pitch_tracking_links: [],
      });
      expect(tables.pitch_facts).not.toBe(tables.relay_event_facts);
      const relayPitchQuery = query.mock.calls.find(([sql]) =>
        String(sql).includes("FROM workbench.relay_pitches"),
      );
      expect(relayPitchQuery).toBeDefined();
      expect(String(relayPitchQuery?.[0]).includes("speed_kph")).toBe(version === 4);
    },
  );

  it("preserves every descriptor column and normalized row while bounding parameters", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const projection = buildRelationalProjection(
      document,
      compileStagingGameDocumentV2(document),
      1,
    );
    const row = projection.tables.relay_event_facts[0];
    if (row === undefined) throw new Error("missing projection row");
    const tables = {
      ...projection.tables,
      relay_event_facts: Array.from({ length: 1201 }, (_, i) => ({
        ...row,
        event_sequence: i,
        event_id: `event-${String(i)}`,
      })),
    };
    const query = vi
      .fn<PoolClient["query"]>()
      .mockResolvedValue({ rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] });
    await writeProjection({ query }, tables);
    const calls = query.mock.calls;
    const headerBatches = calls.filter(([sql]) =>
      String(sql).startsWith("INSERT INTO workbench.relay_event_facts "),
    );
    expect(headerBatches).toHaveLength(3);
    for (const descriptor of PROJECTION_TABLE_DESCRIPTORS) {
      const batches = calls.filter(([sql]) =>
        String(sql).startsWith(`INSERT INTO ${descriptor.schema}.${descriptor.name} `),
      );
      const values = batches.flatMap((call) => call[1]);
      expect(values).toEqual(
        tables[descriptor.name].flatMap((item) => descriptor.columns.map((column) => item[column])),
      );
      for (const [sql, parameters] of batches) {
        expect(Array.isArray(parameters)).toBe(true);
        if (!Array.isArray(parameters)) throw new Error("missing parameters");
        expect(parameters.length).toBeLessThanOrEqual(60_000);
        expect(String(sql)).toContain(`$${String(parameters.length)})`);
      }
    }
  });
});
