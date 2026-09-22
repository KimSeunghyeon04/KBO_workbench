import { describe, expect, it } from "vitest";

import { mapNaverGame, sourceSeasonFromNaverBundle, type RawGameBundle } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { readFile } from "node:fs/promises";

import { sanitizedNaverBundle } from "../helpers/naver.js";

describe("Naver strict mapper", () => {
  it("discards provider zone fields at collection while retaining trajectory and source bundle", async () => {
    const bundle = await mutableBundle();
    const blocks = (
      bundle.payloads.relay_001 as {
        result: {
          textRelayData: { textRelays: Array<{ ptsOptions?: Array<Record<string, unknown>> }> };
        };
      }
    ).result.textRelayData.textRelays;
    const tracking = blocks[0]?.ptsOptions?.[0];
    if (tracking === undefined) throw new Error("missing fixture tracking");
    tracking.topSz = 0.375;
    tracking.bottomSz = 1.5;
    const first = mapNaverGame(bundle);
    expect(first.document.trackingCandidates[0]).not.toHaveProperty("topSz");
    expect(first.document.trackingCandidates[0]).not.toHaveProperty("bottomSz");
    expect(first.document.trackingCandidates[0]).toMatchObject({
      crossPlateX: 0.1,
      resolution: { kind: "linked" },
    });
    tracking.topSz = 100;
    tracking.bottomSz = -10;
    expect(mapNaverGame(bundle).document.trackingCandidates).toEqual(
      first.document.trackingCandidates,
    );
  });
  it("sanitized bundle을 strict 문서로 mapping한다", async () => {
    const mapped = mapNaverGame(await sanitizedNaverBundle());
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.metadata).toMatchObject({
      gameId: "20260715AABB0",
      gameDate: "2026-07-15",
      status: "final",
    });
    expect(mapped.document.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "pitch",
      "plate_result",
    ]);
  });

  it("tracking 원천 후보를 wide typed 값으로 보존한다", async () => {
    const mapped = mapNaverGame(await sanitizedNaverBundle());
    expect(mapped.document.trackingCandidates).toHaveLength(1);
    expect(mapped.document.trackingCandidates.map((item) => item.sourcePitchId)).toEqual([
      "duplicate-source-id",
    ]);
    expect(mapped.document.trackingCandidates[0]).toMatchObject({
      sourcePitchOrdinal: 1,
      crossPlateX: 0.1,
      resolution: { kind: "linked" },
    });
  });

  it("Naver ballcount가 실제 투구 순번과 달라도 고유한 block 내 source ID로 연결한다", async () => {
    const bundle = await mutableBundle();
    const blocks = (
      bundle.payloads.relay_001 as {
        result: {
          textRelayData: { textRelays: Array<{ ptsOptions?: Array<Record<string, unknown>> }> };
        };
      }
    ).result.textRelayData.textRelays;
    const tracking = blocks[0]?.ptsOptions?.[0];
    if (tracking === undefined) throw new Error("tracking fixture가 없습니다.");
    tracking.ballcount = 7;

    const mapped = mapNaverGame(bundle);

    expect(mapped.document.trackingCandidates[0]).toMatchObject({
      sourcePitchOrdinal: 7,
      resolution: { kind: "linked", pitchEventId: expect.any(String) },
    });
    expect(mapped.findings.map((finding) => finding.code)).not.toContain(
      "source.tracking.unlinked",
    );
    const ordinalFinding = compileStagingGameDocumentV2(mapped.document).findings.find(
      (finding) => finding.code === "source.tracking.ordinal_differs_from_actual_pitch",
    );
    expect(ordinalFinding?.severity).toBe("warning");
  });

  it("특수경기 ID 접두사가 아니라 preview 경기 날짜로 source season을 정한다", async () => {
    const bundle = {
      ...(await mutableBundle()),
      gameId: "33331005AABB02026",
    };

    expect(sourceSeasonFromNaverBundle(bundle)).toBe(2026);
    expect(mapNaverGame(bundle).document.metadata.season).toBe(2026);
  });

  it("수정 suffix 이전 block의 원장과 tracking도 함께 보존하고 연결한다", async () => {
    const bundle = await mutableBundle();
    const envelope = bundle.payloads.relay_001 as {
      result: {
        textRelayData: {
          textRelays: Array<{
            title?: string;
            no?: number;
            inn: number;
            homeOrAway: string;
            ptsOptions?: Array<Record<string, unknown>>;
            textOptions: Array<Record<string, unknown>>;
          }>;
        };
      };
    };
    const original = envelope.result.textRelayData.textRelays[0];
    if (original === undefined) throw new Error("테스트 fixture에 relay block이 없습니다.");
    original.title = "같은 타석";
    original.no = 1;
    original.textOptions.forEach((row, index) => {
      row.seqno = 100 + index;
    });
    const corrected = structuredClone(original);
    corrected.no = 2;
    delete corrected.ptsOptions;
    corrected.textOptions.forEach((row, index) => {
      row.seqno = 90 + index;
    });
    envelope.result.textRelayData.textRelays.push(corrected);

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.trackingCandidates).toEqual([
      expect.objectContaining({
        inning: 1,
        half: "top",
        sourcePitchOrdinal: 1,
        resolution: {
          kind: "linked",
          pitchEventId: "20260715AABB0:relay_001:0:2",
        },
      }),
    ]);
    expect(mapped.document.events.map((event) => event.identity.eventId)).toEqual(
      expect.arrayContaining(["20260715AABB0:relay_001:0:2", "20260715AABB0:relay_001:1:2"]),
    );
  });

  it("비식별 회귀 fixture의 인접 타자 시작·1구·tracking 두 묶음을 모두 보존한다", async () => {
    const bundle = await mutableBundle();
    const regression = JSON.parse(
      await readFile(
        "tests/fixtures/naver/repeated-pitch-tracking-adjacent-blocks.anonymized.json",
        "utf8",
      ),
    ) as { blocks: Array<Record<string, unknown>> };
    const relay = bundle.payloads.relay_001 as {
      result: { textRelayData: { textRelays: Array<Record<string, unknown>> } };
    };
    relay.result.textRelayData.textRelays = regression.blocks;

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "pitch",
      "batter_start",
      "pitch",
    ]);
    expect(mapped.document.trackingCandidates.map((candidate) => candidate.resolution)).toEqual([
      {
        kind: "linked",
        pitchEventId: "20260715AABB0:relay_001:0:2",
      },
      {
        kind: "linked",
        pitchEventId: "20260715AABB0:relay_001:1:1",
      },
    ]);
    expect(
      compileStagingGameDocumentV2(mapped.document).findings.filter(
        (finding) => finding.code === "source.pitch_id.reused_within_game",
      ),
    ).toHaveLength(2);
  });

  it("비식별 대타 확인 머리글 뒤 tracking을 compiler가 유지한 열린 타석에 귀속한다", async () => {
    const bundle = await mutableBundle();
    const regression = JSON.parse(
      await readFile("tests/fixtures/naver/tracking-pinch-hitter-context.anonymized.json", "utf8"),
    ) as {
      replacementPlayer: Record<string, unknown>;
      block: Record<string, unknown>;
    };
    const lineup = bundle.payloads.lineup as {
      away_bench?: Array<Record<string, unknown>>;
    };
    lineup.away_bench = [regression.replacementPlayer];
    const relay = bundle.payloads.relay_001 as {
      result: { textRelayData: { textRelays: Array<Record<string, unknown>> } };
    };
    relay.result.textRelayData.textRelays = [regression.block];

    const mapped = mapNaverGame(bundle);
    const replay = compileStagingGameDocumentV2(mapped.document);
    const pitch = replay.pitchFacts[0];
    const tracking = mapped.document.trackingCandidates[0];

    expect(pitch).toMatchObject({
      pitchId: "20260715AABB0:relay_001:0:4",
      plateAppearanceEventId: "20260715AABB0:relay_001:0:1",
      batterId: "A2",
    });
    expect(tracking).toMatchObject({
      plateAppearanceEventId: "20260715AABB0:relay_001:0:1",
      resolution: {
        kind: "linked",
        pitchEventId: "20260715AABB0:relay_001:0:4",
      },
    });
    expect(
      replay.findings.filter(
        (finding) => finding.code === "domain.tracking.plate_appearance_mismatch",
      ),
    ).toEqual([]);
  });

  it("한 투구의 완전히 동일한 tracking 재전송은 모두 보존하고 첫 관측에 자동 귀속한다", async () => {
    const bundle = await mutableBundle();
    const blocks = (
      bundle.payloads.relay_001 as {
        result: {
          textRelayData: { textRelays: Array<{ ptsOptions?: Array<Record<string, unknown>> }> };
        };
      }
    ).result.textRelayData.textRelays;
    const options = blocks[0]?.ptsOptions;
    const first = options?.[0];
    if (options === undefined || first === undefined)
      throw new Error("tracking fixture가 없습니다.");
    options.push(structuredClone(first));

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.trackingCandidates).toHaveLength(2);
    expect(
      mapped.document.trackingCandidates.map((candidate) => candidate.resolution.kind),
    ).toEqual(["linked", "duplicate"]);
    expect(mapped.findings.map((finding) => finding.code)).not.toContain(
      "source.tracking.duplicate_exact",
    );
  });

  it("같은 ID와 같은 투구 문맥의 metric 충돌을 자동 선택하지 않는다", async () => {
    const bundle = await mutableBundle();
    const blocks = (
      bundle.payloads.relay_001 as {
        result: {
          textRelayData: { textRelays: Array<{ ptsOptions?: Array<Record<string, unknown>> }> };
        };
      }
    ).result.textRelayData.textRelays;
    const options = blocks[0]?.ptsOptions;
    const first = options?.[0];
    if (options === undefined || first === undefined)
      throw new Error("tracking fixture가 없습니다.");
    options.push({ ...structuredClone(first), crossPlateX: 0.45 });

    const mapped = mapNaverGame(bundle);
    expect(
      mapped.document.trackingCandidates.every(
        (candidate) => candidate.resolution.kind === "pending",
      ),
    ).toBe(true);
    expect(mapped.findings.map((finding) => finding.code)).toContain(
      "source.tracking.conflicting_candidates",
    );
  });

  it("전체 replay 결과에 blocking finding이 없다", async () => {
    const mapped = mapNaverGame(await sanitizedNaverBundle());
    const replay = compileStagingGameDocumentV2(mapped.document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.plateAppearances).toHaveLength(1);
  });

  it("Naver textRelays 배열이 역순이어도 block no로 원장 시간 순서를 복원한다", async () => {
    const bundle = await mutableBundle();
    const envelope = bundle.payloads.relay_001 as {
      result: {
        textRelayData: {
          textRelays: Array<{
            homeOrAway: string;
            inn: number;
            ptsOptions?: Array<Record<string, unknown>>;
            textOptions: Array<Record<string, unknown>>;
          }>;
        };
      };
    };
    const original = envelope.result.textRelayData.textRelays[0];
    if (original === undefined) throw new Error("테스트 fixture에 relay block이 없습니다.");
    envelope.result.textRelayData.textRelays = original.textOptions
      .map((sourceRow, no) => ({
        homeOrAway: original.homeOrAway,
        inn: original.inn,
        no,
        ...(no === 2 ? { ptsOptions: original.ptsOptions } : {}),
        textOptions: [sourceRow],
      }))
      .reverse();

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "pitch",
      "plate_result",
    ]);
    expect(
      compileStagingGameDocumentV2(mapped.document).findings.map((finding) => finding.code),
    ).not.toEqual(expect.arrayContaining(["event_without_half", "event_half_mismatch"]));
  });

  it("event ID를 relay 원천 위치로 결정적으로 생성한다", async () => {
    const first = mapNaverGame(await sanitizedNaverBundle());
    const second = mapNaverGame(await sanitizedNaverBundle());
    expect(first.document.events.map((event) => event.identity.eventId)).toEqual(
      second.document.events.map((event) => event.identity.eventId),
    );
    expect(first.document.events[2]?.identity.eventId).toBe("20260715AABB0:relay_001:0:2");
  });

  it("같은 block의 동일 ID 투구·tracking을 occurrence 순서로 1:1 연결한다", async () => {
    const bundle = await mutableBundle();
    const rows = relayRows(bundle);
    const repeatedIdPitch = structuredClone(rows[2] ?? {});
    repeatedIdPitch.text = "2구 스트라이크";
    repeatedIdPitch.pitchResult = "S";
    repeatedIdPitch.currentGameState = {
      ...(repeatedIdPitch.currentGameState as Readonly<Record<string, unknown>>),
      ball: "1",
      strike: "1",
    };
    rows.splice(3, 0, repeatedIdPitch);
    const blocks = (
      bundle.payloads.relay_001 as {
        result: {
          textRelayData: {
            textRelays: Array<{ ptsOptions?: Array<Record<string, unknown>> }>;
          };
        };
      }
    ).result.textRelayData.textRelays;
    const tracking = blocks[0]?.ptsOptions?.[0];
    if (tracking === undefined) throw new Error("tracking fixture가 없습니다.");
    blocks[0]?.ptsOptions?.push({ ...structuredClone(tracking), ballcount: 99 });

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.events.filter((event) => event.kind === "pitch")).toHaveLength(2);
    expect(mapped.document.trackingCandidates.map((candidate) => candidate.resolution)).toEqual([
      { kind: "linked", pitchEventId: "20260715AABB0:relay_001:0:2" },
      { kind: "linked", pitchEventId: "20260715AABB0:relay_001:0:3" },
    ]);
    const replay = compileStagingGameDocumentV2(mapped.document);
    expect(
      replay.findings.filter((finding) => finding.code === "source.pitch_id.reused_within_game"),
    ).toHaveLength(2);
    expect(
      replay.findings.filter(
        (finding) => finding.code === "source.tracking.ordinal_differs_from_actual_pitch",
      ),
    ).toHaveLength(1);
  });

  it("같은 block의 동일 ID 투구·tracking 개수가 다르면 임의 연결하지 않는다", async () => {
    const bundle = await mutableBundle();
    const rows = relayRows(bundle);
    rows.splice(3, 0, { ...structuredClone(rows[2] ?? {}), text: "반복된 1구 볼" });

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.trackingCandidates[0]?.resolution).toEqual({ kind: "pending" });
    expect(mapped.findings.map((finding) => finding.code)).toContain(
      "source.tracking.cardinality_mismatch",
    );
  });

  it("tracking은 있지만 같은 block에 대응하는 투구 행이 없으면 pending으로 보존한다", async () => {
    const bundle = await mutableBundle();
    relayRows(bundle).splice(2, 1);

    const mapped = mapNaverGame(bundle);
    expect(mapped.document.trackingCandidates[0]?.resolution).toEqual({ kind: "pending" });
    expect(mapped.findings.map((finding) => finding.code)).toContain("source.tracking.unlinked");
  });

  it("투구 행의 선반영 base 관측을 movement나 불일치 finding으로 만들지 않는다", async () => {
    const bundle = await mutableBundle();
    const rows = relayRows(bundle);
    const pitch = rows[2];
    if (pitch === undefined) throw new Error("테스트 fixture에 투구 행이 없습니다.");
    pitch.currentGameState = {
      ...(pitch.currentGameState as Readonly<Record<string, unknown>>),
      base1: "RUNNER",
    };

    const mapped = mapNaverGame(bundle);
    expect(mapped.findings).toEqual([]);
    expect(mapped.document.events.some((event) => event.kind === "plate_result")).toBe(true);
    expect(
      compileStagingGameDocumentV2(mapped.document).findings.some(
        (finding) => finding.code === "source_observation_mismatch",
      ),
    ).toBe(false);
    expect(mapped.document.events.some((event) => event.kind === "runner_advance")).toBe(false);
  });

  it("상태 코드 0도 3아웃 종료 footer가 함께 있으면 final로 mapping한다", async () => {
    const bundle = await mutableBundle();
    const lineup = bundle.payloads.lineup as {
      game_info: Record<string, unknown>;
    };
    lineup.game_info.statusCode = "0";
    (bundle.payloads as Record<string, unknown>).relay_summary = terminalRelaySummary();

    expect(mapNaverGame(bundle).document.metadata.status).toBe("final");
  });

  it("종료 증거가 없는 상태 코드 0은 final로 추정하지 않는다", async () => {
    const bundle = await mutableBundle();
    const lineup = bundle.payloads.lineup as {
      game_info: Record<string, unknown>;
    };
    lineup.game_info.statusCode = "0";
    (bundle.payloads as Record<string, unknown>).relay_summary = {
      result: { textRelayData: { textRelays: [] } },
    };

    expect(() => mapNaverGame(bundle)).toThrow(/경기 상태/);
  });

  it.each([
    ["6 ⅓", 19],
    ["0 ⅔", 2],
    ["2.1", 7],
    ["3 2/3", 11],
  ])("Naver 투수 이닝 %s를 아웃 수 %i로 변환한다", async (innings, expectedOuts) => {
    const bundle = await mutableBundle();
    const record = bundle.payloads.record as {
      pitcher: { home: Array<Record<string, unknown>> };
    };
    const pitcher = record.pitcher.home[0];
    if (pitcher === undefined) throw new Error("테스트 fixture에 투수 기록이 없습니다.");
    pitcher.inn = innings;

    expect(mapNaverGame(bundle).document.officialRecords.pitchers[0]?.outsRecorded).toBe(
      expectedOuts,
    );
  });

  it("Naver preview의 완료 상태 코드 1을 final로 mapping한다", async () => {
    const bundle = await mutableBundle();
    const lineup = bundle.payloads.lineup as {
      game_info: Record<string, unknown>;
    };
    lineup.game_info.statusCode = "1";
    expect(mapNaverGame(bundle).document.metadata.status).toBe("final");
  });

  it("Naver 공식 기록에 없는 세부 타격 기록을 0으로 꾸며내지 않는다", async () => {
    const mapped = mapNaverGame(await mutableBundle());
    const batter = mapped.document.officialRecords.batters[0];

    expect(batter).toMatchObject({ atBats: 1, hits: 1, homeRuns: 0, walks: 0 });
    expect(batter).not.toHaveProperty("plateAppearances");
    expect(batter).not.toHaveProperty("doubles");
    expect(batter).not.toHaveProperty("hitByPitch");
    expect(batter).not.toHaveProperty("sacrificeBunts");
  });

  it("Naver 투수 pa는 상대 타자 수, bf는 투구 수로 mapping한다", async () => {
    const bundle = await mutableBundle();
    const record = bundle.payloads.record as {
      pitcher: { home: Array<Record<string, unknown>> };
    };
    const pitcher = record.pitcher.home[0];
    if (pitcher === undefined) throw new Error("테스트 fixture에 투수 기록이 없습니다.");
    Object.assign(pitcher, { pa: 21, bf: 81, bb: 2, bbhp: 2, inn: "6 ⅓" });

    expect(mapNaverGame(bundle).document.officialRecords.pitchers[0]).toMatchObject({
      battersFaced: 21,
      pitches: 81,
      hitByPitch: 0,
      outsRecorded: 19,
    });
  });

  it("공식 타자·투수 기록 차이는 적재를 차단한다", async () => {
    const bundle = await mutableBundle();
    const record = bundle.payloads.record as {
      batter: { away: Array<Record<string, unknown>> };
      pitcher: { home: Array<Record<string, unknown>> };
    };
    Object.assign(record.batter.away[0], { ab: 7, hit: 6, hr: 3, rbi: 4 });
    Object.assign(record.pitcher.home[0], { hit: 6 });

    const replay = compileStagingGameDocumentV2(mapNaverGame(bundle).document);
    const mismatches = replay.findings.filter(
      (finding) =>
        finding.code === "official_batter_record_mismatch" ||
        finding.code === "official_pitcher_record_mismatch",
    );

    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.every((finding) => finding.severity === "blocking")).toBe(true);
    expect(mismatches.some((finding) => finding.recordIdentity?.startsWith("batter:"))).toBe(true);
    expect(mismatches.some((finding) => finding.recordIdentity?.startsWith("pitcher:"))).toBe(true);
    expect(
      mismatches
        .flatMap((finding) => finding.details)
        .some((detail) => detail.field === "runsBattedIn"),
    ).toBe(true);
  });

  it("공식 RBI 차이도 보존하고 compiler 검증에서 차단한다", async () => {
    const bundle = await mutableBundle();
    const record = bundle.payloads.record as {
      batter: { away: Array<Record<string, unknown>> };
    };
    const batter = record.batter.away[0];
    if (batter === undefined) throw new Error("테스트 fixture에 타자 기록이 없습니다.");
    batter.rbi = 4;

    const mapped = mapNaverGame(bundle);
    const replay = compileStagingGameDocumentV2(mapped.document);

    expect(mapped.document.officialRecords.batters[0]?.runsBattedIn).toBe(4);
    expect(
      replay.findings.some(
        (finding) =>
          finding.code === "official_batter_record_mismatch" &&
          finding.details.some((detail) => detail.field === "runsBattedIn"),
      ),
    ).toBe(true);
  });
});

async function mutableBundle(): Promise<RawGameBundle> {
  return structuredClone(await sanitizedNaverBundle());
}

function relayRows(bundle: RawGameBundle): Array<Record<string, unknown>> {
  const envelope = bundle.payloads.relay_001 as {
    result: {
      textRelayData: {
        textRelays: Array<{ textOptions: Array<Record<string, unknown>> }>;
      };
    };
  };
  const rows = envelope.result.textRelayData.textRelays[0]?.textOptions;
  if (rows === undefined) throw new Error("테스트 fixture에 relay 행이 없습니다.");
  return rows;
}

function terminalRelaySummary(): unknown {
  return {
    result: {
      textRelayData: {
        textRelays: [
          {
            textOptions: [
              {
                type: 99,
                text: "승리투수: 테스트",
                currentGameState: { out: "3" },
              },
            ],
          },
        ],
      },
    },
  };
}
