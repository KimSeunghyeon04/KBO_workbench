import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  hasKboPlayerSearchMatch,
  KboRegistryHttpClient,
  kboPlayerProfileUrl,
  kboPlayerSearchUrl,
  parseKboPlayerBirthYear,
} from "@kbo/collection";
import { PlayerDirectorySchema, type OfficialPlayerBirthYear } from "@kbo/contracts";
import { OfficialCareerWorkspace } from "@kbo/persistence";
import { Value } from "@sinclair/typebox/value";

const [directoryPath, workspacePath, runId, ...extra] = process.argv.slice(2);
if (!directoryPath || !workspacePath || !runId || extra.length)
  throw new Error(
    "사용법: build-official-player-birth-years <선수 목록 JSON> <작업 경로> <수집 ID>",
  );

const directory = Value.Decode(
  PlayerDirectorySchema,
  JSON.parse(await readFile(directoryPath, "utf8")),
);
const workspace = new OfficialCareerWorkspace(workspacePath, runId);
const client = new KboRegistryHttpClient();
const records: OfficialPlayerBirthYear[] = [];
let covered = 0;
for (const player of directory) {
  const name = player.name.trim().normalize("NFC");
  const matches: OfficialPlayerBirthYear[] = [];
  for (const id of player.sourceIds.filter((value) => /^\d{5}$/.test(value))) {
    for (const role of ["pitcher", "batter"] as const) {
      const source = await workspace.sources.read("profile", `${id}-${role}`);
      if (!source) continue;
      const profile = parseKboPlayerBirthYear(source.body, id);
      if (!profile) continue;
      const alias = profile.name === name ? undefined : await verifiedAlias(id, name, profile.name);
      if (profile.name !== name && !alias) continue;
      matches.push({
        playerId: id,
        name,
        officialName: profile.name,
        birthYear: profile.birthYear,
        profile: {
          url: kboPlayerProfileUrl(id, role),
          artifactKey: source.artifactKey,
          contentHash: source.contentHash,
        },
        ...(alias ? { alias } : {}),
      });
      break;
    }
  }
  if (new Set(matches.map(({ birthYear }) => birthYear)).size === 1) {
    records.push(...matches);
    covered += 1;
  }
}
await workspace.publishBirthYears({ version: 1, records });
console.log(
  JSON.stringify({
    total: directory.length,
    verified: covered,
    aliases: records.filter(({ alias }) => alias !== undefined).length,
  }),
);

async function verifiedAlias(id: string, name: string, officialName: string) {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  const key = `${id}-${digest}`;
  const cached = await workspace.sources.read("alias", key);
  const page = cached ?? (await client.playerSearchPage(name));
  const source =
    cached ?? (await workspace.sources.save({ pageKind: "alias", requestKey: key, ...page }));
  if (!hasKboPlayerSearchMatch(page.body, id, officialName)) return undefined;
  return {
    url: kboPlayerSearchUrl(name),
    artifactKey: source.artifactKey,
    contentHash: source.contentHash,
  };
}
