import { readFile } from "node:fs/promises";
import { KboRegistryHttpClient } from "@kbo/collection";
import { PlayerDirectorySchema, type PlayerDirectoryEntry } from "@kbo/contracts";
import { OfficialCareerWorkspace } from "@kbo/persistence";
import { Value } from "@sinclair/typebox/value";

const [directoryPath, workspacePath, runId, ...extra] = process.argv.slice(2);
if (!directoryPath || !workspacePath || !runId || extra.length)
  throw new Error("사용법: collect-official-player-careers <선수 목록 JSON> <작업 경로> <수집 ID>");

const directory = Value.Decode(
  PlayerDirectorySchema,
  JSON.parse(await readFile(directoryPath, "utf8")),
);
const { sources } = new OfficialCareerWorkspace(workspacePath, runId);
const client = new KboRegistryHttpClient({
  requestsPerSecond: 2,
  timeoutMs: 10_000,
  maxAttempts: 2,
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

function profileRole(player: PlayerDirectoryEntry) {
  return player.primaryPosition === "투수" ||
    player.seasons.every((season) => season.battingPlayerId === null)
    ? "pitcher"
    : "batter";
}

const targets = new Map<string, "batter" | "pitcher">();
for (const player of directory)
  for (const id of player.sourceIds)
    if (/^\d{5}$/.test(id) && !targets.has(id)) targets.set(id, profileRole(player));

const pending = targets.entries();
let completed = 0;
let saved = 0;
let failures = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (const [id, role] of pending) {
      controller.signal.throwIfAborted();
      const key = `${id}-${role}`;
      const previous = await sources.read("profile", key);
      if (previous === null) {
        let page;
        try {
          page = await client.playerProfilePage(id, role, controller.signal);
        } catch (error) {
          controller.signal.throwIfAborted();
          failures += 1;
          console.error(
            JSON.stringify({
              playerId: id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        if (page !== undefined) {
          await sources.save({ pageKind: "profile", requestKey: key, ...page });
          saved += 1;
        }
      }
      completed += 1;
      if (completed % 100 === 0)
        console.log(JSON.stringify({ completed, total: targets.size, saved, failures }));
    }
  }),
);
console.log(JSON.stringify({ completed, total: targets.size, saved, failures }));
