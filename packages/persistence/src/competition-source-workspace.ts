import { createHash } from "node:crypto";
import type { GameCompetition } from "@kbo/contracts";
import { ImmutableTextArtifactStore } from "./immutable-artifact-store.js";

export class CompetitionSourceWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public async save(
    season: number,
    page: { month: number; competition: GameCompetition; body: string; collectedAt: string },
  ) {
    if (
      !Number.isInteger(season) ||
      season < 1982 ||
      season > 2200 ||
      !Number.isInteger(page.month) ||
      page.month < 1 ||
      page.month > 12 ||
      !["preseason", "regular", "postseason"].includes(page.competition)
    )
      throw new Error("잘못된 일정 범위");
    const contentHash = createHash("sha256").update(page.body).digest("hex");
    const store = new ImmutableTextArtifactStore({
      root: this.root,
      artifactKey: () =>
        `reference/competition/${season}/${page.month}-${page.competition}/${contentHash}.json.gz`,
      isPageKind: (value): value is "schedule" => value === "schedule",
      mismatchMessage: () => "일정 원문 무결성 오류",
    });
    await this.assertWriter();
    return store.save({
      pageKind: "schedule",
      requestKey: `${season}:${page.month}:${page.competition}`,
      body: page.body,
      collectedAt: page.collectedAt,
    });
  }
}
