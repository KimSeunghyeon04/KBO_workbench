import { ContractValidationError, parseRegistrySeasonDataset } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

describe("registry season contract", () => {
  it("strict typed source page, snapshot, status event를 decode한다", () => {
    const dataset = parseRegistrySeasonDataset({
      season: 2024,
      dateFrom: "2024-04-01",
      dateTo: "2024-04-01",
      sourcePages: [
        {
          pageKind: "register",
          requestKey: "register:2024-04-01:SS",
          artifactKey: "registry/source/page.html.gz",
          contentHash: "a".repeat(64),
          collectedAt: "2024-04-01T00:00:00.000Z",
        },
      ],
      registrationSnapshots: [
        {
          snapshotDate: "2024-04-01",
          teamCode: "SS",
          teamName: "삼성",
          sourceRequestKey: "register:2024-04-01:SS",
          complete: true,
          players: [],
        },
      ],
      statusEvents: [],
    });
    expect(dataset.season).toBe(2024);
  });

  it("알 수 없는 필드와 잘못된 hash를 거부한다", () => {
    expect(() =>
      parseRegistrySeasonDataset({
        season: 2024,
        dateFrom: "2024-04-01",
        dateTo: "2024-04-01",
        sourcePages: [
          {
            pageKind: "register",
            requestKey: "register:2024-04-01:SS",
            artifactKey: "page.gz",
            contentHash: "invalid",
            collectedAt: "2024-04-01T00:00:00.000Z",
            unexpected: true,
          },
        ],
        registrationSnapshots: [],
        statusEvents: [],
      }),
    ).toThrow(ContractValidationError);
  });
});
