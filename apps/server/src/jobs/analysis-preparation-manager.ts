import type { AnalysisPreparation, GameCompetitionDataset } from "@kbo/contracts";
import {
  COMPETITION_CLASSIFICATION_POLICY_VERSION,
  CompetitionScheduleNoMatchesError,
  type AnalysisPreparationWorkspace,
  type CompetitionClassificationCheckpoint,
  type GameCompetitionRepository,
} from "@kbo/persistence";
import { linkKboCompetitionGames } from "@kbo/collection";
import { createHash } from "node:crypto";
import { canonicalStringify } from "@kbo/contracts";
import type { AnalysisModelJobManager } from "./analysis-model-job-manager.js";

type SeasonSource = Awaited<ReturnType<GameCompetitionRepository["seasons"]>>[number];
const retryMs = 6 * 60 * 60_000;

function matchesSource(
  saved: Pick<SeasonSource, "sourceHash" | "competitionHash"> | null,
  source: SeasonSource,
) {
  return (
    saved?.sourceHash === source.sourceHash && saved.competitionHash === source.competitionHash
  );
}

function matchesClassification(
  checkpoint: CompetitionClassificationCheckpoint | null,
  source: SeasonSource,
): checkpoint is CompetitionClassificationCheckpoint {
  return (
    checkpoint?.policyVersion === COMPETITION_CLASSIFICATION_POLICY_VERSION &&
    matchesSource(checkpoint, source)
  );
}

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
    private readonly store: Pick<
      AnalysisPreparationWorkspace,
      "read" | "write" | "readClassification" | "writeClassification"
    >,
    private readonly collect: (
      season: number,
      signal: AbortSignal,
      games: Awaited<ReturnType<GameCompetitionRepository["games"]>>,
    ) => Promise<GameCompetitionDataset>,
    private readonly models: Pick<AnalysisModelJobManager, "afterImport">,
    private readonly importBusy: () => boolean,
    private readonly now = () => new Date(),
    private readonly reportError: (error: unknown) => void = () => {},
    private readonly automatic = true,
  ) {}
  public start() {
    this.wake(0);
  }
  public wake(delay = 10_000) {
    if (this.closed || !this.automatic) return;
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
    const stored: {
      saved: AnalysisPreparation | null;
      checkpoint: CompetitionClassificationCheckpoint | null;
    }[] = [];
    for (const source of sources) {
      const saved = await this.store.read(source.season);
      const checkpoint = this.automatic ? await this.store.readClassification(source.season) : null;
      stored.push({ saved, checkpoint });
      const matchingStatus = saved !== null && matchesSource(saved, source) ? saved : null;
      const classificationCurrent = matchesClassification(checkpoint, source);
      if (matchingStatus?.state === "classifying" || matchingStatus?.state === "models") {
        preparation.push(matchingStatus);
      } else if (classificationCurrent && checkpoint.error !== null) {
        preparation.push({
          version: 1,
          ...source,
          state: "failed",
          updatedAt: matchingStatus?.updatedAt ?? checkpoint.completedAt,
          error: checkpoint.error,
        });
      } else if (matchingStatus !== null && (!this.automatic || classificationCurrent)) {
        preparation.push(matchingStatus);
      } else {
        preparation.push({
          version: 1,
          ...source,
          state: "pending",
          updatedAt: saved?.updatedAt ?? this.now().toISOString(),
          error: null,
        });
      }
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
    if (this.closed || !this.automatic || this.importBusy()) return;
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

  private async classify(
    source: SeasonSource,
    checkpoint: CompetitionClassificationCheckpoint | null,
  ) {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    await this.save(source, "classifying");
    let competitionHash = source.competitionHash;
    try {
      let linked = false;
      if (
        checkpoint?.policyVersion === COMPETITION_CLASSIFICATION_POLICY_VERSION &&
        checkpoint.error === null &&
        checkpoint.competitionHash === competitionHash
      ) {
        const saved = await this.repository.current(source.season);
        if (saved !== null) {
          try {
            const result = await this.adoptSchedule(saved);
            competitionHash = result.datasetHash;
            linked = result.unclassified === 0;
          } catch (error) {
            if (!(error instanceof CompetitionScheduleNoMatchesError)) throw error;
          }
        }
      }
      if (!linked) {
        // Keep the pre-acquisition source fingerprint. A concurrent import is checked on the next pass.
        const games = await this.repository.games(source.season);
        const fresh = await this.collect(source.season, signal, games);
        signal.throwIfAborted();
        competitionHash = (await this.adoptSchedule(fresh)).datasetHash;
      }
    } catch (error) {
      signal.throwIfAborted();
      this.reportError(error);
      await this.store.writeClassification(
        { ...source, competitionHash },
        this.now().toISOString(),
        error instanceof Error ? error.message : "공식 경기 분류를 갱신하지 못했습니다.",
      );
      return;
    }
    signal.throwIfAborted();
    await this.store.writeClassification({ ...source, competitionHash }, this.now().toISOString());
  }

  private async run() {
    const sources = await this.repository.seasons();
    const pending: SeasonSource[] = [];
    const classifications: {
      source: SeasonSource;
      checkpoint: CompetitionClassificationCheckpoint | null;
    }[] = [];
    for (const source of sources) {
      const saved = await this.store.read(source.season);
      const checkpoint = await this.store.readClassification(source.season);
      const now = this.now().getTime();
      const classificationDue =
        !matchesClassification(checkpoint, source) ||
        ((checkpoint.error !== null || source.unclassified > 0) &&
          now - Date.parse(checkpoint.completedAt) >= retryMs);
      if (classificationDue) classifications.push({ source, checkpoint });
      const modelsDue =
        saved === null ||
        !matchesSource(saved, source) ||
        (saved.state === "failed"
          ? saved.error !== checkpoint?.error && now - Date.parse(saved.updatedAt) >= retryMs
          : saved.state !== "ready");
      if (classificationDue || modelsDue) pending.push(source);
    }
    if (pending.length === 0) return;
    const firstSeason = Math.min(...pending.map((source) => source.season));
    // Older source changes also invalidate models applied in later stored seasons.
    const affected = sources.filter((source) => source.season >= firstSeason);
    for (const { source, checkpoint } of classifications.sort(
      (a, b) => b.source.season - a.source.season,
    )) {
      await this.classify(source, checkpoint);
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
        this.controller.signal.throwIfAborted();
        const checkpoint = await this.store.readClassification(source.season);
        const error = matchesClassification(checkpoint, source) ? checkpoint.error : null;
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
