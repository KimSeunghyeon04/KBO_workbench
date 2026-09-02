import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { parseStagingGameDocumentV2 } from "../packages/contracts/dist/index.js";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
} from "../packages/game-core/dist/index.js";
import { buildReplayBundle } from "../packages/replay/dist/index.js";

const document = parseStagingGameDocumentV2(
  JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")),
);
const input = {
  source: {
    gameId: document.metadata.gameId,
    gameDate: document.metadata.gameDate,
    status: document.metadata.status,
    teams: document.teams,
    rosters: Object.fromEntries(
      ["away", "home"].map((side) => [
        side,
        document.rosters[side].players.map((player) => ({
          playerId: player.playerId,
          name: player.name,
          battingOrder: player.battingOrder ?? null,
          starter: player.starter,
          positions: player.positions,
        })),
      ]),
    ),
    relayEvents: document.events.map((event) => ({
      eventId: event.identity.eventId,
      sequence: event.sequence,
      kind: event.kind,
      relayText: event.relayText ?? null,
      substitution: event.kind === "substitution" ? event.payload : null,
    })),
    trackingCandidates: document.trackingCandidates,
  },
  compiled: compileStagingGameDocumentV2(document),
  revision: 1,
  documentHash: stagingDocumentHash(document),
  projectionHash: "0".repeat(64),
};
const warmupIterations = 50;
const measuredIterations = 500;
for (let index = 0; index < warmupIterations; index += 1) buildReplayBundle(input);

const samples = [];
for (let index = 0; index < measuredIterations; index += 1) {
  const startedAt = performance.now();
  buildReplayBundle(input);
  samples.push(performance.now() - startedAt);
}
samples.sort((left, right) => left - right);
const averageMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
const averageLimitMs = Number(process.env.KBO_REPLAY_AVERAGE_LIMIT_MS ?? "10");
const p95LimitMs = Number(process.env.KBO_REPLAY_P95_LIMIT_MS ?? "25");
const result = {
  fixtureEvents: document.events.length,
  fixturePlays: input.compiled.plays.length,
  iterations: measuredIterations,
  averageMs: Number(averageMs.toFixed(3)),
  p95Ms: Number(p95Ms.toFixed(3)),
  limits: { averageMs: averageLimitMs, p95Ms: p95LimitMs },
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (averageMs > averageLimitMs || p95Ms > p95LimitMs) {
  throw new Error("Replay 성능 기준을 초과했습니다.");
}
