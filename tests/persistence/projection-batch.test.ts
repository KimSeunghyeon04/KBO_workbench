import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { buildRelationalProjection, PROJECTION_TABLE_DESCRIPTORS } from "@kbo/persistence";
import { writeProjection } from "../../packages/persistence/src/projection-repository.js";

describe("projection INSERT batching", () => {
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
