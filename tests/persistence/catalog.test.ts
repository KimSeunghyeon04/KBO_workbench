import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { GameRevisionStore } from "@kbo/persistence";

describe("database game catalog", () => {
  it("current revision, revision 수와 양 팀을 한 query로 집계한다", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          game_id: "anon-game-1",
          season: 2026,
          game_date: "2026-08-30",
          current_revision: 2,
          revision_count: 2,
          away_team_id: "away",
          away_team_name: "비식별 원정",
          home_team_id: "home",
          home_team_name: "비식별 홈",
          updated_at: "2026-08-30T00:00:00.000Z",
          warning_count: 1,
        },
      ],
    }));
    const store = new GameRevisionStore({ query } as unknown as Pool);

    expect(await store.catalog()).toEqual([
      {
        gameId: "anon-game-1",
        season: 2026,
        authority: "database",
        gameDate: "2026-08-30",
        teams: {
          away: { teamId: "away", name: "비식별 원정" },
          home: { teamId: "home", name: "비식별 홈" },
        },
        currentRevision: 2,
        revisionCount: 2,
        updatedAt: "2026-08-30T00:00:00.000Z",
        blockingFindings: 0,
        warningFindings: 1,
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("COUNT(*)::integer AS revision_count");
  });
});
