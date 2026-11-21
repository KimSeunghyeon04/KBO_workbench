import { normalizeNaverRelay } from "@kbo/collection";
import {
  parseStagingGameDocumentV2,
  PlateResultSchema,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { describe, expect, it } from "vitest";
import { BATTED_BALL_CASES } from "../helpers/batted-ball-cases.js";

import {
  emptyForm,
  eventFromForm,
  resultDefaults,
  validateForm,
} from "../../apps/web/src/correction/event-editor-registry.js";

describe("타석 결과 편집기 타구 정보", () => {
  it("계약의 모든 타석 결과를 검증한다", () => {
    expect(BATTED_BALL_CASES.map(([result]) => result).sort()).toEqual(
      PlateResultSchema.anyOf.map((result) => result.const).sort(),
    );
  });

  it.each(BATTED_BALL_CASES)(
    "%s 타구·번트 정보 판정은 수집·원장 검증·교정 입력에서 일치한다",
    (result, allowed) => {
      const document = fixture();
      const original = document.events[0];
      if (original?.kind !== "plate_result") throw new Error("plate result fixture missing");
      const { batterId, pitcherId } = original.payload;
      const isSacrificeFly = result === "sacrifice_fly";
      const text = `비식별 타자 : ${isSacrificeFly ? "뜬공" : "번트 땅볼"}`;
      const collected = normalizeNaverRelay({
        gameId: document.metadata.gameId,
        players: [
          {
            playerId: batterId,
            name: "비식별 타자",
            side: "away",
            starter: true,
            positions: ["야수"],
          },
          {
            playerId: pitcherId,
            name: "비식별 투수",
            side: "home",
            starter: true,
            positions: ["투수"],
          },
        ],
        startingPitchers: { away: null, home: pitcherId },
        closeTrailingHalf: false,
        blocks: [
          {
            endpoint: "relay_001",
            endpointBlockIndex: 0,
            block: {
              inn: 9,
              homeOrAway: "0",
              textOptions: [
                { seqno: 0, kind: "half_inning_start", text: "9회초 시작" },
                { seqno: 1, kind: "batter_start", text: "비식별 타자 타석", batterId, pitcherId },
                { seqno: 2, kind: "plate_result", text, result, batterId, pitcherId },
              ],
            },
          },
        ],
      }).events.find((event) => event.kind === "plate_result");
      expect(collected).toMatchObject({ relayText: text, payload: { result } });
      expect(collected?.payload.battedBallType).toBe(
        allowed ? (isSacrificeFly ? "fly_ball" : "ground_ball") : undefined,
      );
      expect(collected?.payload.isBunt).toBe(allowed ? !isSacrificeFly : undefined);

      for (const fields of [{ battedBallType: "ground_ball" }, { isBunt: false }] as const) {
        const ledger = {
          ...document,
          events: [{ ...original, payload: { result, batterId, pitcherId, ...fields } }],
        };
        if (allowed) {
          expect(parseStagingGameDocumentV2(ledger).events[0]?.payload).toMatchObject(fields);
        } else {
          expect(() => parseStagingGameDocumentV2(ledger)).toThrow(/비인플레이 결과/);
        }
      }

      const form = {
        ...emptyForm(9, "top"),
        kind: "plate_result" as const,
        result,
        batterId,
        pitcherId,
        relayText: "비식별 타자 : 타석 결과",
        battedBallType: "ground_ball",
        isBunt: "false",
      };

      if (!allowed) {
        expect(resultDefaults(result)).toEqual({
          result,
          creditedRbi: "",
          outsRecorded: "",
          batterDestination: "",
          battedBallType: "",
          isBunt: "",
        });
      }

      const event = eventFromForm(form, document, original);
      expect(event).toMatchObject({ kind: "plate_result", payload: { result } });
      if (event?.kind !== "plate_result") throw new Error("plate result form was not accepted");
      expect(event.payload.battedBallType).toBe(allowed ? "ground_ball" : undefined);
      expect(event.payload.isBunt).toBe(allowed ? false : undefined);
    },
  );

  it("인플레이 결과로 돌아가면 결과별 기본값을 복원한다", () => {
    const current = {
      ...emptyForm(9, "top"),
      kind: "plate_result" as const,
      battedBallType: "ground_ball",
      isBunt: "",
    };

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

  it("enum, 숫자 범위와 팀별 선수 범위를 전송 전에 거부한다", () => {
    const document = fixture();
    const valid = {
      ...emptyForm(9, "top"),
      kind: "plate_result" as const,
      batterId: "away-batter",
      pitcherId: "home-pitcher",
      relayText: "비식별 타석 결과",
    };
    expect(validateForm(valid, document)).toBeNull();
    expect(validateForm({ ...valid, result: "invented_result" }, document)).toMatch(/타석 결과/);
    expect(validateForm({ ...valid, creditedRbi: "5" }, document)).toMatch(/0~4/);
    expect(validateForm({ ...valid, batterId: "home-pitcher" }, document)).toMatch(/공수 팀/);
    expect(eventFromForm({ ...valid, result: "invented_result" }, document, undefined)).toBeNull();
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
