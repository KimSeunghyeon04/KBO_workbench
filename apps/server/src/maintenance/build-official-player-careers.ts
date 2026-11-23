import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  careerClubKey,
  careerCoversObservedClubs,
  KboRegistryHttpClient,
  kboPlayerProfileUrl,
  parseCareerMovement,
  parseKboPlayerCareerProfile,
  parseKboTradeResponse,
} from "@kbo/collection";
import {
  isCalendarDate,
  PlayerDirectorySchema,
  type OfficialPlayerCareerRecord,
  type RegistryStatusEvent,
} from "@kbo/contracts";
import { OfficialCareerWorkspace } from "@kbo/persistence";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const [directoryPath, workspacePath, runId, reviewedPath, ...extra] = process.argv.slice(2);
if (!directoryPath || !workspacePath || !runId || !reviewedPath || extra.length)
  throw new Error(
    "사용법: build-official-player-careers <선수 목록 JSON> <작업 경로> <수집 ID> <검토한 이적 JSON>",
  );

const directory = Value.Decode(
  PlayerDirectorySchema,
  JSON.parse(await readFile(directoryPath, "utf8")),
);
const workspace = new OfficialCareerWorkspace(workspacePath, runId);
const client = new KboRegistryHttpClient();
type Evidence = OfficialPlayerCareerRecord["sources"][number];
type Profile = NonNullable<ReturnType<typeof parseKboPlayerCareerProfile>>;
type Move = { date: string; source: Evidence };
const kboMovementsUrl = "https://www.koreabaseball.com/Player/Trade.aspx";
const profiles: { profile: Profile; source: Evidence }[] = [];

for (const player of directory) {
  for (const id of player.sourceIds.filter((id) => /^\d{5}$/.test(id))) {
    for (const role of ["pitcher", "batter"] as const) {
      const artifact = await workspace.sources.read("profile", `${id}-${role}`);
      if (!artifact) continue;
      const profile = parseKboPlayerCareerProfile(artifact.body, id);
      if (!profile || profile.name !== player.name.normalize("NFC")) continue;
      const first = player.seasons.at(-1)?.season;
      const last = player.seasons[0]?.season;
      if (
        first === undefined ||
        last === undefined ||
        profile.firstSeason > first ||
        profile.lastSeason < last ||
        !careerCoversObservedClubs(profile.clubs, player.teams)
      )
        continue;
      profiles.push({
        profile,
        source: {
          url: kboPlayerProfileUrl(id, role),
          artifactKey: artifact.artifactKey,
          contentHash: artifact.contentHash,
        },
      });
      break;
    }
  }
}

const events: { event: RegistryStatusEvent; source: Evidence }[] = [];
const latestSeason = Math.max(2017, ...profiles.map(({ profile }) => profile.lastSeason));
for (let season = 2017; season <= latestSeason; season += 1) {
  const limit = 1000;
  let remaining = 0;
  let page = 0;
  do {
    page += 1;
    const key = `${season}-${page}`;
    const cached = await workspace.sources.read("movement", key);
    const response = cached ?? (await client.tradePage(season, 0, page, limit));
    const result = parseKboTradeResponse(JSON.parse(response.body), key, (page - 1) * limit);
    if (
      (page > 1 && remaining !== result.totalCount - (page - 1) * limit) ||
      result.events.length !==
        Math.min(limit, Math.max(0, result.totalCount - (page - 1) * limit)) ||
      result.events.some(
        (event) =>
          !event.effectiveDate.startsWith(`${season}-`) || !isCalendarDate(event.effectiveDate),
      )
    )
      throw new Error(`KBO 선수 이동 응답의 범위가 맞지 않습니다. ${key}`);
    const evidence =
      cached ??
      (await workspace.sources.save({
        pageKind: "movement",
        requestKey: key,
        body: response.body,
        collectedAt: response.collectedAt,
      }));
    const source = {
      url: kboMovementsUrl,
      artifactKey: evidence.artifactKey,
      contentHash: evidence.contentHash,
    };
    events.push(...result.events.map((event) => ({ event, source })));
    remaining = result.totalCount - page * limit;
  } while (remaining > 0);
}

const reviewed = Value.Decode(
  Type.Array(
    Type.Object(
      {
        playerId: Type.String({ pattern: "^\\d{5}$" }),
        name: Type.String({ minLength: 1 }),
        from: Type.String({ minLength: 1 }),
        to: Type.String({ minLength: 1 }),
        date: Type.String({ minLength: 10, maxLength: 10 }),
        url: Type.String({
          pattern:
            "^https://(?:www\\.samsunglions\\.com|tigers\\.co\\.kr|www\\.koreabaseball\\.com)/",
        }),
        localHtml: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,80}\\.html$" }),
        proof: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  JSON.parse(await readFile(reviewedPath, "utf8")),
);
const reviewedMoves = new Map<string, Move[]>();
for (const [index, move] of reviewed.entries()) {
  if (!isCalendarDate(move.date)) throw new Error("공식 이적 검토 날짜가 올바르지 않습니다.");
  const requestKey = `${move.playerId}-${index}`;
  const cached = await workspace.sources.read("move", requestKey);
  const page =
    cached?.body ?? (await readFile(path.join(path.dirname(reviewedPath), move.localHtml), "utf8"));
  if (!move.proof.every((part) => page.includes(part)) || !page.includes(move.name))
    throw new Error(`공식 이적 원문에서 검토 근거를 확인하지 못했습니다. ${move.playerId}`);
  const artifact =
    cached ??
    (await workspace.sources.save({
      pageKind: "move",
      requestKey,
      body: page,
      collectedAt: new Date().toISOString(),
    }));
  const key = moveKey(move.playerId, move.from, move.to);
  const value = { date: move.date, source: { url: move.url, ...artifact } };
  const previous = reviewedMoves.get(key) ?? [];
  reviewedMoves.set(key, [...previous, value]);
}

function moveKey(identity: string, from: string, to: string) {
  return [identity, careerClubKey(from), careerClubKey(to)].join("\u0000");
}

function playerKey(name: string, position: string) {
  return `${name}\u0000${position}`;
}

const uniqueDirectoryNames = new Map<string, number>();
for (const player of directory)
  uniqueDirectoryNames.set(player.name, (uniqueDirectoryNames.get(player.name) ?? 0) + 1);

const officialMoves = new Map<string, Move[]>();
const eligibility = new Map<string, typeof events>();
for (const row of events) {
  const { event } = row;
  if (event.eventKind !== "free_agent_eligibility" || !event.rawPosition) continue;
  const key = playerKey(event.rawPlayerName, event.rawPosition);
  const previous = eligibility.get(key) ?? [];
  eligibility.set(key, [...previous, row]);
}
for (const { event, source } of events) {
  if (!event.rawPosition || uniqueDirectoryNames.get(event.rawPlayerName) !== 1) continue;
  const actor = playerKey(event.rawPlayerName, event.rawPosition);
  const explicit = parseCareerMovement({
    effect: event.affiliationEffect,
    note: event.rawNote,
    team: event.teamName,
  });
  let key = explicit && moveKey(actor, explicit.from, explicit.to);
  if (!key && event.eventKind === "free_agent_contract") {
    const cutoff = Date.parse(event.effectiveDate) - 75 * 86400_000;
    const possible = (eligibility.get(actor) ?? []).filter(
      ({ event: candidate }) =>
        candidate.effectiveDate < event.effectiveDate &&
        Date.parse(candidate.effectiveDate) >= cutoff,
    );
    const eligible = possible.length === 1 ? possible[0] : undefined;
    const from =
      eligible?.source.artifactKey === source.artifactKey ? eligible.event.teamName : undefined;
    if (from && careerClubKey(from) !== careerClubKey(event.teamName))
      key = moveKey(actor, from, event.teamName);
  }
  if (!key) continue;
  const previous = officialMoves.get(key) ?? [];
  if (!previous.some(({ date }) => date === event.effectiveDate))
    officialMoves.set(key, [...previous, { date: event.effectiveDate, source }]);
}

const records: OfficialPlayerCareerRecord[] = [];
for (const { profile, source } of profiles) {
  const first = profile.clubs[0];
  if (!first) continue;
  const clubs: OfficialPlayerCareerRecord["career"]["clubs"] = [{ name: first, joinedOn: null }];
  const sources = [source];
  let previousDate = `${profile.firstSeason - 1}-12-31`;
  for (const club of profile.clubs.slice(1)) {
    const from = clubs.at(-1)?.name ?? first;
    const candidates =
      reviewedMoves.get(moveKey(profile.playerId, from, club)) ??
      officialMoves.get(moveKey(playerKey(profile.name, profile.position), from, club)) ??
      [];
    const matches = candidates.filter(
      ({ date }) => date > previousDate && date <= `${profile.lastSeason}-12-31`,
    );
    const verified = matches.length === 1 ? matches[0] : undefined;
    if (!verified) break;
    clubs.push({ name: club, joinedOn: verified.date });
    sources.push(verified.source);
    previousDate = verified.date;
  }
  if (clubs.length === profile.clubs.length)
    records.push({
      playerId: profile.playerId,
      name: profile.name,
      career: { firstSeason: profile.firstSeason, lastSeason: profile.lastSeason, clubs },
      sources,
    });
}
await workspace.publish({ version: 1, records });
console.log(
  JSON.stringify({
    profiles: profiles.length,
    movementRows: events.length,
    verified: records.length,
    withMoves: records.filter(({ career }) => career.clubs.length > 1).length,
  }),
);
