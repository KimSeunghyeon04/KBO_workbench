import {
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  emptyForm,
  eventFromForm,
  plateResultAllowsBattedBall,
  resultDefaults,
} from "../../apps/web/src/correction/event-editor-registry.js";

const NON_BATTED_BALL_RESULTS = [
  "walk",
  "intentional_walk",
  "hit_by_pitch",
  "strikeout",
  "interference",
] as const;

describe("타석 결과 편집기 타구 정보", () => {
  it.each(NON_BATTED_BALL_RESULTS)(
    "%s 선택 시 타구 입력을 초기화하고 payload에서 제외한다",
    (result) => {
      const document = fixture();
      const original = document.events[0];
      if (original?.kind !== "plate_result") throw new Error("plate result fixture missing");
      const form = {
        ...emptyForm(9, "top"),
        kind: "plate_result" as const,
        result,
        batterId: "away-batter",
        pitcherId: "home-pitcher",
        relayText: "비식별 타자 : 타석 결과",
        battedBallType: "ground_ball",
        isBunt: "false",
      };

      expect(plateResultAllowsBattedBall(result)).toBe(false);
      expect(resultDefaults(result)).toEqual({
        result,
        creditedRbi: "",
        outsRecorded: "",
        batterDestination: "",
        battedBallType: "",
        isBunt: "",
      });

      const event = eventFromForm(form, document, original);
      expect(event?.kind).toBe("plate_result");
      if (event?.kind !== "plate_result") return;
      expect(event.payload).not.toHaveProperty("battedBallType");
      expect(event.payload).not.toHaveProperty("isBunt");
    },
  );

  it("인플레이 결과로 돌아가면 결과별 기본값을 복원한다", () => {
    const current = {
      ...emptyForm(9, "top"),
      kind: "plate_result" as const,
      battedBallType: "ground_ball",
      isBunt: "",
    };

    expect(plateResultAllowsBattedBall("field_out")).toBe(true);
    expect({ ...current, ...resultDefaults("field_out") }).toMatchObject({
      result: "field_out",
      battedBallType: "",
      isBunt: "false",
    });
    expect({ ...current, ...resultDefaults("sacrifice_bunt") }).toMatchObject({
      result: "sacrifice_bunt",
      battedBallType: "",
      isBunt: "true",
    });
    expect({ ...current, ...resultDefaults("sacrifice_fly") }).toMatchObject({
      result: "sacrifice_fly",
      battedBallType: "fly_ball",
      isBunt: "false",
    });
  });
});

function fixture(): StagingGameDocumentV2 {
  const result: StagingRelayEvent = {
    identity: {
      kind: "source",
      eventId: "plate-result-fixture",
      endpoint: "test-relay",
      blockIndex: 0,
      eventIndex: 0,
    },
    sequence: 0,
    inning: 9,
    half: "top",
    relayText: "비식별 타자 : 땅볼 아웃",
    kind: "plate_result",
    payload: {
      result: "field_out",
      batterId: "away-batter",
      pitcherId: "home-pitcher",
      battedBallType: "ground_ball",
      isBunt: false,
    },
  };
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "editor-fixture",
      collectedAt: "2026-08-20T03:00:00.000Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "editor-fixture",
      season: 2026,
      gameDate: "2026-08-20",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "원정팀" },
      home: { teamId: "HOME", name: "홈팀" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: [
          {
            playerId: "away-batter",
            name: "비식별 타자",
            starter: true,
            positions: ["타자"],
          },
        ],
      },
      home: {
        teamId: "HOME",
        players: [
          {
            playerId: "home-pitcher",
            name: "비식별 투수",
            starter: true,
            positions: ["투수"],
          },
        ],
      },
    },
    events: [result],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  });
}
