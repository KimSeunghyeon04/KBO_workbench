import { readFile } from "node:fs/promises";
import { resolveNaverPitcherHand } from "@kbo/collection";
import { OfficialPitcherHandRepository } from "@kbo/persistence";
import { Pool } from "pg";
import { loadConfig } from "../config.js";

const [flag, profileFile, option, ...extra] = process.argv.slice(2);
if (
  flag !== "--profile" ||
  !profileFile ||
  (option !== undefined && option !== "--dry-run") ||
  extra.length
)
  throw new Error("사용법: --profile <검토한 공식 투구 손 JSON> [--dry-run]");
const config = loadConfig();
const pool = new Pool(config.database);
try {
  const input: unknown = JSON.parse(await readFile(profileFile, "utf8"));
  const repository = new OfficialPitcherHandRepository(pool, resolveNaverPitcherHand);
  const dryRun = option === "--dry-run";
  console.log(JSON.stringify({ dryRun, ...(await repository.importProfile(input, dryRun)) }));
} finally {
  await pool.end();
}
