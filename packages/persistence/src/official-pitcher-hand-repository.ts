import { createHash } from "node:crypto";
import { canonicalStringify, parseOfficialPitcherHandProfile } from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import { PersistenceIntegrityError } from "./errors.js";
import type { ResolvePitcherHand } from "./pitcher-hands.js";

const pitchCountSchema = Type.Object({ pitches: Type.Integer({ minimum: 0 }) });
const hashSchema = Type.Object({ evidenceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }) });

export class OfficialPitcherHandRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly resolve: ResolvePitcherHand,
  ) {}

  public async importProfile(input: unknown, dryRun = false) {
    const profile = parseOfficialPitcherHandProfile(input);
    const pitcherHand = this.resolve([profile.reportedHand]);
    if (pitcherHand === null)
      throw new PersistenceIntegrityError("공식 프로필에 유효한 투구 손 표기가 없습니다.");
    const evidenceHash = createHash("sha256")
      .update(canonicalStringify({ ...profile, pitcherHand }))
      .digest("hex");
    const key = [profile.gameId, profile.sourceBundleHash, profile.pitcherId];
    const client = await this.pool.connect();
    try {
      await client.query(dryRun ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      if (!dryRun)
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `official-pitcher-hand:${key.join(":")}`,
        ]);
      const target = await client.query(
        `SELECT count(*)::int AS pitches
         FROM analytics.current_game_revisions r
         JOIN baseball.pitch_facts p USING(game_id,revision)
         WHERE r.game_id=$1 AND r.source_bundle_hash=$2 AND p.pitcher_id=$3 AND p.actual
         AND EXISTS (
           SELECT 1 FROM workbench.game_roster_snapshots roster
           WHERE roster.game_id=p.game_id AND roster.revision=p.revision
             AND roster.player_id=p.pitcher_id AND roster.player_name=$4
             AND roster.side=CASE WHEN p.half='top' THEN 'home' ELSE 'away' END
         )`,
        [...key, profile.pitcherName],
      );
      const { pitches } = Value.Decode(pitchCountSchema, target.rows[0]);
      if (pitches === 0)
        throw new PersistenceIntegrityError(
          "현재 봉인 기록에서 원문 해시와 투수 ID·이름이 일치하는 투구가 없습니다.",
        );

      const existing = await client.query(
        `SELECT evidence_hash AS "evidenceHash" FROM registry.official_pitcher_hands
         WHERE (game_id,source_bundle_hash,pitcher_id)=($1,$2,$3)`,
        key,
      );
      const saved = existing.rows[0];
      if (saved !== undefined && Value.Decode(hashSchema, saved).evidenceHash !== evidenceHash)
        throw new PersistenceIntegrityError("이미 등록한 공식 투구 손의 근거가 다릅니다.");
      const added = saved === undefined && !dryRun;
      if (added)
        await client.query(
          `INSERT INTO registry.official_pitcher_hands
           (game_id,source_bundle_hash,pitcher_id,pitcher_name,pitcher_hand,reported_hand,source_url,checked_on,evidence_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ...key,
            profile.pitcherName,
            pitcherHand,
            profile.reportedHand,
            profile.sourceUrl,
            profile.checkedOn,
            evidenceHash,
          ],
        );
      await client.query("COMMIT");
      return { pitcherHand, pitches, added };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
