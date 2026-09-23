import type { RecordCorrectionJob } from "@kbo/contracts";
import type { Pool } from "pg";
import { assertContract, iso, nullableIso } from "./record-correction-db.js";
import type { RecordCorrectionResumableJob } from "./record-correction-types.js";
export class RecordCorrectionJobs {
  public constructor(
    private readonly pool: Pool,
    private readonly expectedMigrationVersion: string,
  ) {}
  public async seasonsWithSealedGames(): Promise<number[]> {
    const result = await this.pool.query<{ readonly season: number }>(
      `SELECT DISTINCT r.season
       FROM workbench.games g JOIN workbench.game_revisions r
         ON r.game_id=g.game_id AND r.revision=g.current_revision
       WHERE r.sealed ORDER BY r.season`,
    );
    return result.rows.map((row) => row.season);
  }

  public async createJob(
    jobId: string,
    trigger: "manual" | "scheduled",
    idempotencyKey: string,
    seasons: readonly number[],
    createdAt: string,
  ): Promise<{ readonly created: boolean; readonly job: RecordCorrectionJob }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertContract(client, this.expectedMigrationVersion);
      const existing = await client.query<{ readonly run_id: string }>(
        "SELECT run_id FROM record_correction.collection_runs WHERE idempotency_key=$1",
        [idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        return { created: false, job: await this.job(existing.rows[0].run_id) };
      }
      await client.query(
        `INSERT INTO record_correction.collection_runs
           (run_id,trigger_kind,idempotency_key,status,created_at)
         VALUES ($1,$2,$3,'queued',$4)`,
        [jobId, trigger, idempotencyKey, createdAt],
      );
      for (const [seasonOrder, season] of seasons.entries())
        await client.query(
          `INSERT INTO record_correction.collection_run_seasons
             (run_id,season,season_order,status)
           VALUES ($1,$2,$3,'queued')`,
          [jobId, season, seasonOrder],
        );
      await client.query("COMMIT");
      return { created: true, job: await this.job(jobId) };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async setJobRunning(jobId: string, startedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_runs
       SET status='running',started_at=COALESCE(started_at,$2),finished_at=NULL,
           error_category=NULL,error_message=NULL WHERE run_id=$1`,
      [jobId, startedAt],
    );
  }

  public async resumableJobs(): Promise<RecordCorrectionResumableJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertContract(client, this.expectedMigrationVersion);
      const interrupted = await client.query<{ readonly run_id: string }>(
        `SELECT run_id FROM record_correction.collection_runs
         WHERE status IN ('queued','running') ORDER BY created_at,run_id FOR UPDATE`,
      );
      const jobs: RecordCorrectionResumableJob[] = [];
      for (const row of interrupted.rows) {
        await client.query(
          `UPDATE record_correction.collection_run_seasons SET status='queued'
           WHERE run_id=$1 AND status='running'`,
          [row.run_id],
        );
        const seasons = await client.query<{ readonly season: number; readonly status: string }>(
          `SELECT season,status FROM record_correction.collection_run_seasons
           WHERE run_id=$1 ORDER BY season_order`,
          [row.run_id],
        );
        const pending = seasons.rows.filter((item) => item.status === "queued");
        if (pending.length > 0) {
          jobs.push({
            jobId: row.run_id,
            seasons: pending.map((item) => item.season),
            hasChanges: seasons.rows.some((item) => item.status === "succeeded"),
          });
        } else {
          await client.query(
            `UPDATE record_correction.collection_runs
             SET status=$2,finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP)
             WHERE run_id=$1`,
            [
              row.run_id,
              seasons.rows.some((item) => item.status === "succeeded") ? "succeeded" : "no_change",
            ],
          );
        }
      }
      await client.query(
        `UPDATE record_correction.collection_runs SET status='cancelled',finished_at=CURRENT_TIMESTAMP
         WHERE status='cancelling'`,
      );
      await client.query("COMMIT");
      return jobs;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async setJobCancelling(jobId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE record_correction.collection_runs SET status='cancelling'
       WHERE run_id=$1 AND status IN ('queued','running')`,
      [jobId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async finishJob(
    jobId: string,
    status: "cancelled" | "succeeded" | "failed" | "no_change",
    finishedAt: string,
    errorCategory: "source" | "domain" | "persistence" | null = null,
    errorMessage: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_runs
       SET status=$2,finished_at=$3,error_category=$4,error_message=$5 WHERE run_id=$1`,
      [jobId, status, finishedAt, errorCategory, errorMessage],
    );
  }

  public async markSeasonRunning(jobId: string, season: number): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_run_seasons SET status='running'
       WHERE run_id=$1 AND season=$2`,
      [jobId, season],
    );
  }

  public async markSeasonFailed(jobId: string, season: number): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_run_seasons SET status='failed'
       WHERE run_id=$1 AND season=$2`,
      [jobId, season],
    );
  }

  public async job(jobId: string): Promise<RecordCorrectionJob> {
    const result = await this.pool.query<{
      readonly run_id: string;
      readonly status: RecordCorrectionJob["status"];
      readonly trigger_kind: RecordCorrectionJob["trigger"];
      readonly created_at: Date | string;
      readonly started_at: Date | string | null;
      readonly finished_at: Date | string | null;
      readonly error_message: string | null;
    }>("SELECT * FROM record_correction.collection_runs WHERE run_id=$1", [jobId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`record correction job이 없습니다: ${jobId}`);
    const seasons = await this.pool.query<{
      readonly season: number;
      readonly status: string;
    }>(
      `SELECT season,status FROM record_correction.collection_run_seasons
       WHERE run_id=$1 ORDER BY season_order`,
      [jobId],
    );
    return {
      jobId: row.run_id,
      status: row.status,
      trigger: row.trigger_kind,
      seasons: seasons.rows.map((season) => season.season),
      createdAt: iso(row.created_at),
      startedAt: nullableIso(row.started_at),
      finishedAt: nullableIso(row.finished_at),
      completedSeasons: seasons.rows.filter((season) =>
        ["succeeded", "failed", "no_change"].includes(season.status),
      ).length,
      totalSeasons: seasons.rows.length,
      error: row.error_message,
    };
  }

  public async jobs(): Promise<RecordCorrectionJob[]> {
    const result = await this.pool.query<{ readonly run_id: string }>(
      "SELECT run_id FROM record_correction.collection_runs ORDER BY created_at DESC LIMIT 100",
    );
    return Promise.all(result.rows.map((row) => this.job(row.run_id)));
  }
}
