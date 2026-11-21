import type { AnalysisPreparation, GameCompetitionDataset } from "@kbo/contracts";
import {
  CompetitionScheduleNoMatchesError,
  type AnalysisPreparationWorkspace,
  type GameCompetitionRepository,
} from "@kbo/persistence";
import { linkKboCompetitionGames } from "@kbo/collection";
import { createHash } from "node:crypto";
import { canonicalStringify } from "@kbo/contracts";
import type { AnalysisModelJobManager } from "./analysis-model-job-manager.js";

type SeasonSource = Awaited<ReturnType<GameCompetitionRepository["seasons"]>>[number];
const retryMs = 6 * 60 * 60_000;

/** Reconcile from sealed DB pointers, including imports completed just before a crash.
 * The DB is the durable queue; no game ledger or sealed revision is written here.
 */
export class AnalysisPreparationManager {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private closed = false;
  private readonly controller = new AbortController();
  public constructor(
    private readonly repository: Pick<
      GameCompetitionRepository,
      "seasons" | "current" | "games" | "adopt"
    >,
    private readonly store: Pick<AnalysisPreparationWorkspace, "read" | "write">,
    private readonly collect: (
      season: number,
      signal: AbortSignal,
    ) => Promise<GameCompetitionDataset>,
    private readonly models: Pick<AnalysisModelJobManager, "afterImport">,
    private readonly importBusy: () => boolean,
    private readonly now = () => new Date(),
    private readonly reportError: (error: unknown) => void = () => {},
  ) {}
  public start() {
    this.wake(0);
  }
  public wake(delay = 10_000) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.check()
        .catch(this.reportError)
        .finally(() => this.wake(60_000));
    }, delay);
    this.timer.unref();
  }
  public async status() {
    const sources = await this.repository.seasons();
    const preparation: AnalysisPreparation[] = [];
    const stored: (AnalysisPreparation | null)[] = [];
    for (const source of sources) {
      const saved = await this.store.read(source.season);
      stored.push(saved);
      preparation.push(
        saved !== null &&
          saved.sourceHash === source.sourceHash &&
          saved.competitionHash === source.competitionHash
          ? saved
          : {
              version: 1,
              ...source,
              state: "pending",
              updatedAt: saved?.updatedAt ?? this.now().toISOString(),
              error: null,
            },
      );
    }
    const sourceHash = createHash("sha256")
      .update(canonicalStringify({ sources, preparation: stored }))
      .digest("hex");
    return {
      sourceHash,
      seasons: sources.map((source) => source.season).sort((a, b) => b - a),
      preparation,
    };
  }
  public async check() {
    if (this.closed || this.importBusy()) return;
    if (this.active !== null) return this.active;
    this.active = this.run()
      .catch((error: unknown) => {
        if (!this.closed) throw error;
        if (error !== this.controller.signal.reason) this.reportError(error);
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }
  private async save(
    source: SeasonSource,
    state: AnalysisPreparation["state"],
    error: string | null = null,
  ) {
    await this.store.write({
      version: 1,
      ...source,
      state,
      updatedAt: this.now().toISOString(),
      error,
    });
  }
  private async adoptSchedule(dataset: GameCompetitionDataset) {
    const games = await this.repository.games(dataset.season);
    const links = linkKboCompetitionGames(dataset, games);
    this.controller.signal.throwIfAborted();
    return this.repository.adopt(dataset, false, links);
  }
  private async run() {
    const sources = await this.repository.seasons();
    const pending: SeasonSource[] = [];
    for (const source of sources) {
      const saved = await this.store.read(source.season);
      const changed =
        saved?.sourceHash !== source.sourceHash || saved.competitionHash !== source.competitionHash;
      if (
        changed ||
        ((saved.state !== "ready" || saved.unclassified > 0) &&
          ((saved.state !== "failed" && saved.state !== "ready") ||
            this.now().getTime() - Date.parse(saved.updatedAt) >= retryMs))
      )
        pending.push(source);
    }
    if (pending.length === 0) return;
    const firstSeason = Math.min(...pending.map((source) => source.season));
    // Older source changes also invalidate models applied in later stored seasons.
    const affected = sources.filter((source) => source.season >= firstSeason);
    const classificationErrors = new Map<number, string>();
    for (const source of sources
      .filter(
        (row) =>
          pending.some((item) => item.season === row.season) ||
          (row.season >= firstSeason && row.unclassified > 0),
      )
      .sort((a, b) => b.season - a.season)) {
      this.controller.signal.throwIfAborted();
      await this.save(source, "classifying");
      try {
        const saved = await this.repository.current(source.season);
        if (saved !== null) {
          try {
            if ((await this.adoptSchedule(saved)).unclassified === 0) continue;
          } catch (error) {
            if (!(error instanceof CompetitionScheduleNoMatchesError)) throw error;
          }
        }
        const fresh = await this.collect(source.season, this.controller.signal);
        this.controller.signal.throwIfAborted();
        await this.adoptSchedule(fresh);
      } catch (error) {
        if (this.closed) throw error;
        this.reportError(error);
        classificationErrors.set(
          source.season,
          error instanceof Error ? error.message : "공식 경기 분류를 갱신하지 못했습니다.",
        );
      }
    }
    // Unknown games stay excluded from regular-season facts. Existing model gates still
    // decide whether the remaining verified sample supports an estimate.
    const classified = await this.repository.seasons();
    const modelTargets = affected.map((source) => {
      const current = classified.find((row) => row.season === source.season);
      return {
        ...source,
        competitionHash: current?.competitionHash ?? null,
        unclassified: current?.unclassified ?? source.unclassified,
      };
    });
    // Persist every dependent season before the triggering season can become ready.
    for (const source of modelTargets) {
      this.controller.signal.throwIfAborted();
      await this.save(source, "models");
    }
    for (const source of modelTargets) {
      this.controller.signal.throwIfAborted();
      try {
        if (source.season >= 2023) await this.models.afterImport(source.season);
        const error = classificationErrors.get(source.season) ?? null;
        await this.save(source, error === null ? "ready" : "failed", error);
      } catch (error) {
        if (this.closed) throw error;
        this.reportError(error);
        await this.save(
          source,
          "failed",
          error instanceof Error ? error.message : "분석 모델을 갱신하지 못했습니다.",
        );
      }
    }
  }

  public async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    await this.active;
  }
}
