import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeNaverRelay, type RelayBlockInput, type RelayRosterPlayer } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

type JsonRow = Readonly<Record<string, unknown>>;

interface RegressionFixture {
  readonly "20240504OBLG02024": {
    readonly duplicateWalkResults: readonly JsonRow[];
  };
  readonly "20240724WOOB02024": {
    readonly crossHalfDawsonResult: {
      readonly previous: JsonRow;
      readonly mixed: JsonRow;
    };
    readonly repeatedPitchResultGroup: readonly JsonRow[];
    readonly missingDawsonResultThenSongPitches: readonly JsonRow[];
  };
}

interface AnonymizedImplementationRegressionFixture {
  readonly duplicatePitcherSubstitution: readonly JsonRow[];
  readonly atomicRunnerIdentity: readonly JsonRow[];
  readonly reachedOnErrorRbi: readonly JsonRow[];
  readonly staleRunnerReplay: readonly JsonRow[];
  readonly hitByPitchTerminalCount: readonly JsonRow[];
}

const fixture = JSON.parse(
  await readFile(path.resolve("tests/fixtures/naver/quarantine-relay-regressions.json"), "utf8"),
) as RegressionFixture;

const anonymizedFixture = JSON.parse(
  await readFile(
    path.resolve("tests/fixtures/naver/anonymized-quarantine-implementation-regressions.json"),
    "utf8",
  ),
) as AnonymizedImplementationRegressionFixture;

describe("격리 경기 실제 relay 회귀", () => {
  it("동명이인 투수 교체는 직전 활성 투수로 나가는 선수를 식별한다", () => {
    const players = [
      roster("away-batter", "원정타자", "away", 1),
      roster("away-pitcher", "원정투수", "away", undefined, ["투수"]),
      roster("home-pitcher-active", "동명투수", "home", undefined, ["투수"]),
      roster("home-pitcher-inactive", "동명투수", "home", undefined, ["투수"]),
      roster("home-pitcher-new", "새투수", "home", undefined, ["투수"]),
    ];
    const result = normalize(
      "20260101ANON0",
      [relayBlock(1, "top", 1, anonymizedFixture.duplicatePitcherSubstitution)],
      players,
      { away: "away-pitcher", home: "home-pitcher-active" },
    );

    expect(result.findings).toEqual([]);
    expect(result.events[2]).toMatchObject({
      kind: "substitution",
      payload: {
        role: "pitcher",
        incomingPlayerId: "home-pitcher-new",
        outgoingPlayerId: "home-pitcher-active",
      },
    });
    expect(blockingFindings("20260101ANON0", players, result.events)).toEqual([]);
  });

  it("같은 타격 play의 이동은 시작 시점 베이스로 동명이인 득점 주자를 식별한다", () => {
    const players = [
      roster("runner-correct", "동명주자", "away", 1),
      roster("runner-duplicate", "동명주자", "away"),
      roster("runner-first", "선행주자", "away", 2),
      roster("current-batter", "현재타자", "away", 3),
      roster("away-pitcher", "원정투수", "away", undefined, ["투수"]),
      roster("home-pitcher", "홈투수", "home", undefined, ["투수"]),
    ];
    const result = normalize(
      "20260102ANON0",
      [relayBlock(1, "top", 1, anonymizedFixture.atomicRunnerIdentity)],
      players,
      { away: "away-pitcher", home: "home-pitcher" },
    );
    const movements = result.events.filter((event) => event.kind === "runner_advance");

    expect(result.findings).toEqual([]);
    expect(movements.map((event) => event.payload.runnerId)).toEqual([
      "current-batter",
      "runner-first",
      "runner-correct",
    ]);
    expect(blockingFindings("20260102ANON0", players, result.events)).toEqual([]);
  });

  it("명시적 타점이 없는 실책 출루 득점에 0타점을 합성하지 않는다", () => {
    const players = [
      roster("lead-runner", "선행주자", "away", 1),
      roster("error-batter", "실책타자", "away", 2),
      roster("away-pitcher", "원정투수", "away", undefined, ["투수"]),
      roster("home-pitcher", "홈투수", "home", undefined, ["투수"]),
    ];
    const result = normalize(
      "20260103ANON0",
      [relayBlock(1, "top", 1, anonymizedFixture.reachedOnErrorRbi)],
      players,
      { away: "away-pitcher", home: "home-pitcher" },
    );
    const errorResult = result.events.find(
      (event) => event.kind === "plate_result" && event.payload.result === "reached_on_error",
    );

    expect(errorResult?.kind === "plate_result" ? errorResult.payload : null).not.toHaveProperty(
      "creditedRbi",
    );
    const findings = compileStagingGameDocumentV2({
      ...documentFor("20260103ANON0", players, result.events),
      officialRecords: {
        batters: [
          {
            playerId: "error-batter",
            side: "away",
            atBats: 1,
            runs: 0,
            hits: 0,
            homeRuns: 0,
            runsBattedIn: 1,
            walks: 0,
            strikeouts: 0,
          },
        ],
        pitchers: [],
      },
    }).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "official_rbi_not_verifiable", severity: "warning" }),
      ]),
    );
    expect(findings.some((finding) => finding.severity === "blocking")).toBe(false);
  });

  it("새 타자 머리글 뒤 재전송된 직전 주자 이동도 원천 행별로 보존한다", () => {
    const result = normalize(
      "20260104ANON0",
      [relayBlock(1, "top", 1, anonymizedFixture.staleRunnerReplay)],
      [
        roster("replayed-runner", "재전송주자", "away", 1),
        roster("result-batter", "결과타자", "away", 2),
        roster("next-batter", "다음타자", "away", 3),
        roster("away-pitcher", "원정투수", "away", undefined, ["투수"]),
        roster("home-pitcher", "홈투수", "home", undefined, ["투수"]),
      ],
      { away: "away-pitcher", home: "home-pitcher" },
    );

    expect(result.events.filter((event) => event.kind === "runner_advance")).toHaveLength(2);
  });

  it("사구 결과 직전의 Naver 볼 투구를 실제 사구 투구로 보강한다", () => {
    const players = [
      roster("hit-batter", "사구타자", "away", 1),
      roster("away-pitcher", "원정투수", "away", undefined, ["투수"]),
      roster("home-pitcher", "홈투수", "home", undefined, ["투수"]),
    ];
    const result = normalize(
      "20260105ANON0",
      [relayBlock(1, "top", 1, anonymizedFixture.hitByPitchTerminalCount)],
      players,
      { away: "away-pitcher", home: "home-pitcher" },
    );
    const pitches = result.events.filter((event) => event.kind === "pitch");
    const lastPitch = pitches.at(-1);

    expect(pitches.map((event) => event.payload.call)).toEqual([
      "called_strike",
      "swinging_strike",
      "ball",
      "foul",
      "ball",
      "hit_by_pitch",
    ]);
    expect(lastPitch).toMatchObject({
      relayText: "6구 볼",
      observedStateAfter: { balls: 4, strikes: 2 },
    });

    const document = documentFor("20260105ANON0", players, result.events);
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.plateAppearances).toEqual([
      expect.objectContaining({ result: "hit_by_pitch", actualPitchCount: 6 }),
    ]);

    const legacyBallEvents = result.events.map((event) =>
      event.identity.eventId === lastPitch?.identity.eventId && event.kind === "pitch"
        ? { ...event, payload: { ...event.payload, call: "ball" as const } }
        : event,
    );
    const legacyReplay = compileStagingGameDocumentV2(
      documentFor("20260105ANON1", players, legacyBallEvents),
    );
    expect(
      legacyReplay.findings.filter((finding) => finding.code === "source_observation_mismatch"),
    ).toEqual([]);

    const wrongStrikeEvents = legacyBallEvents.map((event) =>
      event.identity.eventId === lastPitch?.identity.eventId
        ? {
            ...event,
            observedStateAfter: { ...event.observedStateAfter, strikes: 1 },
          }
        : event,
    );
    const wrongStrike = compileStagingGameDocumentV2(
      documentFor("20260105ANON2", players, wrongStrikeEvents),
    );
    expect(
      wrongStrike.findings.filter((finding) => finding.code === "source_observation_mismatch"),
    ).toEqual([
      expect.objectContaining({
        details: [{ field: "strikes", expected: 1, actual: 2 }],
      }),
    ]);
  });

  it("20240504의 동일 볼넷 결과 재전송을 두 원천 타석 결과로 보존한다", () => {
    const rows = fixture["20240504OBLG02024"].duplicateWalkResults;
    const result = normalize(
      "20240504OBLG02024",
      [
        relayBlock(7, "top", 65, [
          sourceRow(347, 0, "7회초 두산 공격"),
          sourceRow(348, 8, "1번타자 정수빈"),
          ...rows,
        ]),
      ],
      [
        roster("79231", "정수빈", "away", 1),
        roster("64596", "LG 투수", "home", undefined, ["투수"]),
      ],
      { away: null, home: "64596" },
    );

    expect(result.events.filter((event) => event.kind === "plate_result")).toHaveLength(2);
  });

  it("20240724의 직전 반이닝 혼입은 unresolved로, 반복 투구·결과는 원천 행별로 보존한다", () => {
    const source = fixture["20240724WOOB02024"];
    const crossHalf = normalize(
      "20240724WOOB02024",
      [
        relayBlock(5, "top", 45, [
          sourceRow(256, 0, "5회초 키움 공격"),
          sourceRow(257, 8, "4번타자 도슨"),
          source.crossHalfDawsonResult.previous,
        ]),
        relayBlock(5, "bottom", 46, [
          sourceRow(259, 0, "5회말 두산 공격"),
          source.crossHalfDawsonResult.mixed,
        ]),
      ],
      game20240724Roster(),
      { away: "54368", home: "68220" },
    );
    const repeated = normalize(
      "20240724WOOB02024",
      [
        relayBlock(7, "top", 65, [
          sourceRow(376, 0, "7회초 키움 공격"),
          sourceRow(377, 8, "8번타자 김건희"),
          ...source.repeatedPitchResultGroup,
          sourceRow(382, 8, "9번타자 이재상"),
        ]),
      ],
      game20240724Roster(),
      { away: "54368", home: "77263" },
    );

    expect(crossHalf.events.filter((event) => event.kind === "plate_result")).toHaveLength(1);
    expect(crossHalf.events.filter((event) => event.kind === "unresolved")).toHaveLength(1);
    expect(repeated.events.filter((event) => event.kind === "pitch")).toHaveLength(2);
    expect(repeated.events.filter((event) => event.kind === "plate_result")).toHaveLength(2);
    const dawson = crossHalf.events.find((event) => event.kind === "plate_result");
    const kim = repeated.events.find((event) => event.kind === "plate_result");
    expect(dawson?.kind === "plate_result" ? dawson.payload.battedBallType : null).toBe("fly_ball");
    expect(dawson?.relayText).toBe("도슨 : 우익수 플라이 아웃");
    expect(kim?.kind === "plate_result" ? kim.payload.battedBallType : null).toBe("ground_ball");
    expect(kim?.relayText).toContain("3루수 땅볼 아웃");
  });

  it("20240724의 도슨 결과 누락 뒤 송성문 투구를 도슨에게 귀속하지 않는다", () => {
    const rows = fixture["20240724WOOB02024"].missingDawsonResultThenSongPitches;
    const result = normalize(
      "20240724WOOB02024",
      [
        relayBlock(9, "top", 99, [
          sourceRow(556, 0, "9회초 키움 공격"),
          sourceRow(557, 8, "4번타자 도슨"),
          ...rows,
        ]),
      ],
      game20240724Roster(),
      { away: "54368", home: "54263" },
    );
    const pitches = result.events.filter((event) => event.kind === "pitch");

    expect(result.findings).toEqual([]);
    expect(
      pitches.map((event) => (event.kind === "pitch" ? event.payload.batterId : null)),
    ).toEqual(["53327", "53327", "65357", "65357"]);
    expect(result.events.some((event) => event.kind === "plate_result")).toBe(false);
  });
});

function normalize(
  gameId: string,
  blocks: readonly RelayBlockInput[],
  players: readonly RelayRosterPlayer[],
  startingPitchers: Readonly<Record<"away" | "home", string | null>>,
) {
  return normalizeNaverRelay({
    gameId,
    blocks,
    players,
    startingPitchers,
    closeTrailingHalf: true,
  });
}

function relayBlock(
  inning: number,
  half: "top" | "bottom",
  no: number,
  textOptions: readonly JsonRow[],
): RelayBlockInput {
  return {
    endpoint: `relay_${String(inning).padStart(3, "0")}`,
    endpointBlockIndex: no,
    block: {
      inn: inning,
      homeOrAway: half === "top" ? "0" : "1",
      no,
      textOptions,
    },
  };
}

function sourceRow(seqno: number, type: number, text: string): JsonRow {
  return { seqno, type, text };
}

function roster(
  playerId: string,
  name: string,
  side: "away" | "home",
  battingOrder?: number,
  positions: readonly string[] = ["내야수"],
): RelayRosterPlayer {
  return {
    playerId,
    name,
    side,
    ...(battingOrder === undefined ? {} : { battingOrder }),
    starter: true,
    positions,
  };
}

function game20240724Roster(): readonly RelayRosterPlayer[] {
  return [
    roster("53327", "도슨", "away", 4),
    roster("53312", "김건희", "away", 8),
    roster("54305", "이재상", "away", 9),
    roster("65357", "송성문", "away", 5),
    roster("54368", "키움 투수", "away", undefined, ["투수"]),
    roster("68205", "전민재", "home", 9),
    roster("68220", "두산 선발", "home", undefined, ["투수"]),
    roster("77263", "두산 투수1", "home", undefined, ["투수"]),
    roster("54263", "두산 투수2", "home", undefined, ["투수"]),
  ];
}

function blockingFindings(
  gameId: string,
  players: readonly RelayRosterPlayer[],
  events: ReturnType<typeof normalizeNaverRelay>["events"],
) {
  return compileStagingGameDocumentV2(documentFor(gameId, players, events)).findings.filter(
    (finding) => finding.severity === "blocking",
  );
}

function documentFor(
  gameId: string,
  players: readonly RelayRosterPlayer[],
  events: ReturnType<typeof normalizeNaverRelay>["events"],
) {
  return {
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: gameId,
      collectedAt: "2026-01-01T12:00:00+09:00",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId,
      season: 2026,
      gameDate: "2026-01-01",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "ANON-AWAY", name: "원정" },
      home: { teamId: "ANON-HOME", name: "홈" },
    },
    rosters: {
      away: {
        teamId: "ANON-AWAY",
        players: players.filter((player) => player.side === "away").map(contractPlayer),
      },
      home: {
        teamId: "ANON-HOME",
        players: players.filter((player) => player.side === "home").map(contractPlayer),
      },
    },
    events,
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  };
}

function contractPlayer(player: RelayRosterPlayer) {
  return {
    playerId: player.playerId,
    name: player.name,
    ...(player.battingOrder === undefined ? {} : { battingOrder: player.battingOrder }),
    starter: player.starter,
    positions: player.positions,
  };
}
