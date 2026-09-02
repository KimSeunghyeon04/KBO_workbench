import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeNaverRelay, type RelayBlockInput, type RelayRosterPlayer } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

interface RunnerFixtureFile {
  readonly players: readonly FixturePlayer[];
  readonly cases: readonly RunnerFixtureCase[];
}

interface FixturePlayer {
  readonly playerId: string;
  readonly name: string;
  readonly side: "away" | "home";
  readonly battingOrder?: number;
  readonly positions?: readonly string[];
}

interface RunnerFixtureCase {
  readonly id: string;
  readonly sourceTest: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly expected: {
    readonly score: number;
    readonly outs: number;
    readonly bases: readonly (string | null)[];
    readonly movementOrder: readonly string[];
  };
}

describe("기존 Python 주자 relay fixture 회귀", async () => {
  const fixture = JSON.parse(
    await readFile(path.resolve("tests/fixtures/naver/runner-relay-cases.json"), "utf8"),
  ) as RunnerFixtureFile;
  const players = fixture.players.map(toRelayPlayer);

  for (const fixtureCase of fixture.cases) {
    it(`${fixtureCase.id} (${fixtureCase.sourceTest})`, () => {
      const block: RelayBlockInput = {
        endpoint: "relay_001",
        endpointBlockIndex: 0,
        block: {
          inn: 1,
          homeOrAway: "0",
          no: 1,
          textOptions: fixtureCase.rows,
          ptsOptions: [],
        },
      };
      const normalized = normalizeNaverRelay({
        gameId: "20260820RUNNR",
        blocks: [block],
        players,
        startingPitchers: { away: "ap1", home: "hp1" },
        closeTrailingHalf: false,
      });
      const replay = compileStagingGameDocumentV2(documentFor(normalized.events, players));
      const lastResult = [...normalized.events]
        .reverse()
        .find((event) => event.kind === "plate_result");
      const runnerRows = normalized.events.filter((event) => event.kind === "runner_advance");

      expect(normalized.findings, fixtureCase.id).toEqual([]);
      expect(lastResult?.kind).toBe("plate_result");
      if (lastResult?.kind !== "plate_result") {
        throw new Error(`${fixtureCase.id}: 타석 결과가 없습니다.`);
      }
      expect(runnerRows).toHaveLength(
        fixtureCase.rows.filter((row) => Number(row.type) === 24).length,
      );
      expect(runnerRows.every((event) => event.relayText !== undefined)).toBe(true);
      const play = replay.plays.find((item) =>
        item.relayEventIds.includes(lastResult.identity.eventId),
      );
      expect(play?.movements.length).toBeGreaterThan(0);
      expect(
        play?.movements.map(
          (movement) =>
            `${movement.runnerId}:${String(movement.fromBase)}-${String(movement.toBase)}:${movement.outcome}`,
        ),
      ).toEqual(fixtureCase.expected.movementOrder);
      expect(
        replay.findings.filter((finding) => finding.severity === "blocking"),
        fixtureCase.id,
      ).toEqual([]);
      expect(replay.finalState.awayScore, fixtureCase.id).toBe(fixtureCase.expected.score);
      expect(replay.finalState.outs, fixtureCase.id).toBe(fixtureCase.expected.outs);
      expect(
        replay.finalState.bases.map((base) => base?.runnerId ?? null),
        fixtureCase.id,
      ).toEqual(fixtureCase.expected.bases);
    });
  }
});

function toRelayPlayer(player: FixturePlayer): RelayRosterPlayer {
  const positions = player.positions ?? ["내야수"];
  return {
    playerId: player.playerId,
    name: player.name,
    side: player.side,
    ...(player.battingOrder === undefined ? {} : { battingOrder: player.battingOrder }),
    starter: player.battingOrder !== undefined || positions.includes("투수"),
    positions,
  };
}

function documentFor(
  events: ReturnType<typeof normalizeNaverRelay>["events"],
  players: readonly RelayRosterPlayer[],
) {
  return {
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "20260820RUNNR",
      collectedAt: "2026-08-20T12:00:00+09:00",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "20260820RUNNR",
      season: 2026,
      gameDate: "2026-08-20",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "원정" },
      home: { teamId: "HOME", name: "홈" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: players.filter((player) => player.side === "away").map(toContractPlayer),
      },
      home: {
        teamId: "HOME",
        players: players.filter((player) => player.side === "home").map(toContractPlayer),
      },
    },
    events,
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  };
}

function toContractPlayer(player: RelayRosterPlayer) {
  return {
    playerId: player.playerId,
    name: player.name,
    ...(player.battingOrder === undefined ? {} : { battingOrder: player.battingOrder }),
    starter: player.starter,
    positions: player.positions,
  };
}
