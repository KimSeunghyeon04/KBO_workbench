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

// Synthetic nine-inning ledger: no network or operational game files are needed.
const events = [];
for (let inning = 1; inning <= 9; inning++) {
  for (const half of ["top", "bottom"]) {
    const batting = half === "top" ? "a" : "h";
    const pitcherId = half === "top" ? "hp1" : "ap1";
    const add = (kind, payload) => {
      const sequence = events.length;
      events.push({
        identity: {
          kind: "source",
          eventId: `perf-${sequence}`,
          endpoint: "fixture",
          blockIndex: 0,
          eventIndex: sequence,
        },
        sequence,
        inning,
        half,
        kind,
        payload,
        relayText: "성능 fixture",
      });
    };
    add("half_inning_start", {});
    for (let out = 0; out < 3; out++) {
      const batterId = `${batting}${(((inning - 1) * 3 + out) % 9) + 1}`;
      add("batter_start", { batterId, pitcherId });
      for (const call of [
        "ball",
        "called_strike",
        "foul",
        "foul",
        "ball",
        "foul",
        "foul",
        "swinging_strike",
      ])
        add("pitch", { call });
      add("plate_result", { result: "strikeout", batterId, pitcherId });
    }
  }
}
const large = parseStagingGameDocumentV2({
  ...document,
  events,
  trackingCandidates: [],
  officialRecords: { batters: [], pitchers: [] },
  rosters: Object.fromEntries(
    ["away", "home"].map((side) => {
      const prefix = side === "away" ? "a" : "h";
      return [
        side,
        {
          teamId: document.teams[side].teamId,
          players: [
            ...Array.from({ length: 9 }, (_, i) => ({
              playerId: `${prefix}${i + 1}`,
              name: `비식별 ${prefix}${i + 1}`,
              battingOrder: i + 1,
              starter: true,
              positions: ["IF"],
            })),
            { playerId: `${prefix}p1`, name: "비식별 투수", starter: true, positions: ["P"] },
          ],
        },
      ];
    }),
  ),
});
const verified = compileStagingGameDocumentV2(large);
if (verified.findings.some((finding) => finding.severity === "blocking"))
  throw new Error("성능 fixture의 전체 컴파일에 차단 오류가 있습니다.");
for (let i = 0; i < 20; i++) compileStagingGameDocumentV2(large);
const compilerSamples = [];
for (let i = 0; i < 200; i++) {
  const start = performance.now();
  compileStagingGameDocumentV2(large);
  compilerSamples.push(performance.now() - start);
}
compilerSamples.sort((a, b) => a - b);
const compilerAverage =
  compilerSamples.reduce((sum, value) => sum + value, 0) / compilerSamples.length;
const compilerP95 = compilerSamples[Math.floor(compilerSamples.length * 0.95)];
process.stdout.write(
  `${JSON.stringify({ operation: "compile", fixtureEvents: large.events.length, iterations: compilerSamples.length, averageMs: Number(compilerAverage.toFixed(3)), p95Ms: Number(compilerP95.toFixed(3)), limits: { averageMs: 10, p95Ms: 25 } })}\n`,
);
if (compilerAverage > 10 || compilerP95 > 25) throw new Error("Compiler 성능 기준을 초과했습니다.");
