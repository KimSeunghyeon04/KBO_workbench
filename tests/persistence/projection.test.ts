import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import {
  buildRelationalProjection,
  hashProjectionTables,
  PROJECTION_TABLE_COLUMNS,
} from "@kbo/persistence";

describe("원장 + compiled fact 관계형 projection", () => {
  it("모든 원장 행을 header와 정확히 한 kind subtype에 1:1 보존한다", async () => {
    const document = await golden();
    const projection = buildRelationalProjection(
      document,
      compileStagingGameDocumentV2(document),
      1,
    );
    expect(projection.version).toBe(3);
    expect(projection.tables.tracking_observations).toHaveLength(
      document.trackingCandidates.length,
    );
    expect(projection.tables.relay_event_facts).toHaveLength(document.events.length);
    expect(projection.tables.relay_event_facts[10]).toMatchObject({
      event_sequence: 10,
      event_id: "e10",
      identity_kind: "source",
      source_endpoint: "relay",
      source_block_index: 0,
      source_event_index: 10,
      kind: "plate_result",
      relay_text: "원정2 : 좌전 안타",
    });
    expect(projection.tables.relay_plate_results).toContainEqual(
      expect.objectContaining({
        event_sequence: 10,
        event_id: "e10",
        kind: "plate_result",
        plate_result: "single",
      }),
    );
    expect(
      [
        projection.tables.relay_half_inning_starts,
        projection.tables.relay_batter_starts,
        projection.tables.relay_pitches,
        projection.tables.relay_plate_results,
        projection.tables.relay_runner_advances,
        projection.tables.relay_substitutions,
        projection.tables.relay_reviews,
        projection.tables.relay_administrative,
        projection.tables.relay_unresolved,
      ].reduce((count, rows) => count + rows.length, 0),
    ).toBe(document.events.length);
    expect(Object.keys(projection.tables.relay_event_facts[0] ?? {})).toEqual(
      PROJECTION_TABLE_COLUMNS.relay_event_facts,
    );
  });

  it("모든 projection 행은 DB descriptor와 정확히 같은 컬럼만 가진다", async () => {
    const document = await golden();
    const projection = buildRelationalProjection(
      document,
      compileStagingGameDocumentV2(document),
      1,
    );

    for (const [table, columns] of Object.entries(PROJECTION_TABLE_COLUMNS)) {
      for (const row of projection.tables[table as keyof typeof projection.tables]) {
        expect(Object.keys(row), table).toEqual(columns);
        expect(Object.values(row), table).not.toContain(undefined);
      }
    }
  });

  it("공급자가 PTS 순번을 주지 않은 linked tracking도 nullable 원천값으로 projection한다", async () => {
    const fixture = await golden();
    const document = parseStagingGameDocumentV2({
      ...fixture,
      trackingCandidates: fixture.trackingCandidates.map((candidate, index) =>
        index === 0 ? { ...candidate, sourcePitchOrdinal: null } : candidate,
      ),
    });
    const replay = compileStagingGameDocumentV2(document);

    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(
      buildRelationalProjection(document, replay, 1).tables.tracking_observations[0],
    ).toMatchObject({ source_pitch_ordinal: null });
  });

  it("finding detail scalar를 DB 컬럼명과 null 의미를 보존해 projection한다", async () => {
    const document = await golden();
    const replay = compileStagingGameDocumentV2(document);
    const projection = buildRelationalProjection(
      document,
      {
        ...replay,
        findings: [
          {
            code: "sanitized_projection_warning",
            category: "source",
            severity: "warning",
            message: "비식별 projection 회귀 finding",
            gameId: document.metadata.gameId,
            details: [
              { field: "text", expected: "원천", actual: "계산" },
              { field: "number", expected: 7, actual: 8 },
              { field: "boolean", expected: true, actual: false },
              { field: "null", expected: null, actual: null },
              { field: "omitted" },
            ],
          },
        ],
      },
      1,
    );

    expect(projection.tables.validation_issue_details).toEqual([
      expect.objectContaining({
        field: "text",
        expected_type: "string",
        expected_text: "원천",
        expected_number: null,
        expected_boolean: null,
        actual_type: "string",
        actual_text: "계산",
      }),
      expect.objectContaining({
        field: "number",
        expected_type: "number",
        expected_text: null,
        expected_number: 7,
        actual_number: 8,
      }),
      expect.objectContaining({
        field: "boolean",
        expected_type: "boolean",
        expected_boolean: true,
        actual_boolean: false,
      }),
      expect.objectContaining({
        field: "null",
        expected_type: "null",
        actual_type: "null",
      }),
      expect.objectContaining({
        field: "omitted",
        expected_type: "null",
        actual_type: "null",
      }),
    ]);
  });

  it("누락·초과·undefined projection 컬럼을 hash 전에 거부한다", async () => {
    const document = await golden();
    const projection = buildRelationalProjection(
      document,
      compileStagingGameDocumentV2(document),
      1,
    );
    const validationRun = projection.tables.validation_runs[0];
    expect(validationRun).toBeDefined();
    if (validationRun === undefined) return;

    const withExtra = {
      ...projection.tables,
      validation_runs: [{ ...validationRun, unexpected_column: "invalid" }],
    };
    expect(() => hashProjectionTables(withExtra)).toThrow(/초과=unexpected_column/);

    const missingColumn = { ...validationRun };
    Reflect.deleteProperty(missingColumn, "warning_count");
    const withMissing = { ...projection.tables, validation_runs: [missingColumn] };
    expect(() => hashProjectionTables(withMissing)).toThrow(/누락=warning_count/);

    const undefinedColumn = { ...validationRun };
    Object.defineProperty(undefinedColumn, "warning_count", { value: undefined });
    const withUndefined = { ...projection.tables, validation_runs: [undefinedColumn] };
    expect(() => hashProjectionTables(withUndefined)).toThrow(/undefined=warning_count/);
  });

  it("결과와 연결 주자 원장 행을 한 play bridge와 최종 movement fact로 분리한다", async () => {
    const document = await golden();
    const projection = buildRelationalProjection(
      document,
      compileStagingGameDocumentV2(document),
      1,
    );
    const bridge = projection.tables.play_events.filter(
      (row) => row.event_id === "e10" || row.event_id === "e11",
    );
    expect(bridge).toHaveLength(2);
    expect(new Set(bridge.map((row) => row.play_sequence)).size).toBe(1);
    const playSequence = bridge[0]?.play_sequence;
    const movements = projection.tables.runner_movement_facts.filter(
      (row) => row.play_sequence === playSequence,
    );
    expect(movements).toEqual([
      expect.objectContaining({ runner_id: "a1", source_event_id: "e11", derived: false }),
      expect.objectContaining({ runner_id: "a2", source_event_id: null, derived: true }),
    ]);
  });

  it("PA bridge는 실제 소속 원장 행과 실제 투구 번호만 포함한다", async () => {
    const document = await golden();
    const projection = buildRelationalProjection(
      document,
      compileStagingGameDocumentV2(document),
      1,
    );
    expect(projection.tables.plate_appearance_facts[0]).toMatchObject({
      completed: true,
      result: "walk",
      termination_reason: "plate_result",
      start_event_id: "e1",
      end_event_id: "e6",
      actual_pitch_count: 3,
    });
    expect(
      projection.tables.plate_appearance_events
        .filter((row) => row.plate_appearance_index === 0)
        .map((row) => [row.event_id, row.pitch_number]),
    ).toEqual([
      ["e1", null],
      ["e2", 1],
      ["e3", 2],
      ["e4", null],
      ["e5", 3],
      ["e6", null],
    ]);
  });

  it("projection hash는 원장 fact와 compiled fact 변화 모두에 반응하고 결정적이다", async () => {
    const document = await golden();
    const replay = compileStagingGameDocumentV2(document);
    const projection = buildRelationalProjection(document, replay, 1);
    expect(projection.projectionHash).toBe(hashProjectionTables(projection.tables));
    expect(buildRelationalProjection(document, replay, 1).projectionHash).toBe(
      projection.projectionHash,
    );
    const changedTables = {
      ...projection.tables,
      relay_event_facts: projection.tables.relay_event_facts.map((row, index) =>
        index === 7 ? { ...row, relay_text: "정정 공지" } : row,
      ),
    };
    expect(hashProjectionTables(changedTables)).not.toBe(projection.projectionHash);
  });
});

async function golden() {
  return parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
}
