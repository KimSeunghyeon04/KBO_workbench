import { readFile } from "node:fs/promises";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mapNaverGame, hashRawGameBundle, type RawGameBundle } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { describe, expect, it } from "vitest";

const fixture = Value.Decode(
  Type.Object({
    gameId: Type.String(),
    collectedAt: Type.String(),
    missingEndpoints: Type.Array(Type.String()),
    payloads: Type.Record(Type.String(), Type.Unknown()),
  }),
  JSON.parse(
    await readFile("tests/fixtures/naver/missing-roster-boxscore.anonymized.json", "utf8"),
  ) as unknown,
);

function bundle(): RawGameBundle {
  return structuredClone(fixture);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("객체 fixture가 필요합니다.");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("배열 fixture가 필요합니다.");
  return value.map(object);
}
function recordRoot(raw: RawGameBundle) {
  return object(raw.payloads.record);
}
function pitcher(raw: RawGameBundle) {
  const row = rows(object(recordRoot(raw).pitchersBoxscore).home)[0];
  if (row === undefined) throw new Error("투수 fixture가 필요합니다.");
  return row;
}

describe("박스스코어 근거의 누락 로스터 보완", () => {
  it("명시 ID가 없으면 이름만으로 새 ID를 만들지 않는다", () => {
    const raw = bundle();
    delete pitcher(raw).pcode;
    expect(() => mapNaverGame(raw)).toThrow(/공식 투수 ID/);
  });

  it("박스스코어 행 순서와 무관하게 추가 로스터를 ID순으로 정렬한다", () => {
    const raw = bundle();
    const record = object(recordRoot(raw).battersBoxscore);
    record.away = [{ playerCode: "A3", name: "원정후속" }, ...rows(record.away)];
    const first = mapNaverGame(raw);
    record.away = rows(record.away).reverse();
    expect(mapNaverGame(raw).document.rosters).toEqual(first.document.rosters);
    expect(first.document.rosters.away.players.map((player) => player.playerId)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
  });

  it("기존 선수의 축약 박스스코어 이름으로 preview 이름을 바꾸거나 새 충돌을 만들지 않는다", () => {
    const raw = bundle();
    object(recordRoot(raw).battersBoxscore).home = [{ playerCode: "HP1", name: "홈선" }];
    const mapped = mapNaverGame(raw);
    expect(mapped.document.rosters.home.players[0]?.name).toBe("홈선발");
    expect(mapped.findings.some((finding) => finding.severity === "blocking")).toBe(false);
  });

  it("누락 구원투수·후보 타자를 선발·타순 추정 없이 보완하고 전체 컴파일한다", () => {
    const raw = bundle();
    const before = structuredClone(raw);
    const mapped = mapNaverGame(raw);
    expect(mapped.document.rosters.home.players).toContainEqual({
      playerId: "HP2",
      name: "홈구원",
      starter: false,
      positions: ["투수"],
    });
    expect(mapped.document.rosters.away.players).toContainEqual({
      playerId: "A2",
      name: "원정후보",
      starter: false,
      positions: [],
    });
    expect(mapped.document.rosters.home.players[0]).toEqual({
      playerId: "HP1",
      name: "홈선발",
      starter: true,
      positions: ["투수"],
    });
    expect(mapped.document.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "substitution",
      "pitch",
    ]);
    expect(mapped.document.events[2]).toMatchObject({
      relayText: "투수 홈선발 : 투수 홈구원 (으)로 교체",
      identity: { endpoint: "relay_001", blockIndex: 0, eventIndex: 2 },
    });
    expect(
      [...mapped.findings, ...compileStagingGameDocumentV2(mapped.document).findings].filter(
        (finding) => finding.severity === "blocking",
      ),
    ).toEqual([]);
    expect(
      mapped.findings.filter(
        (finding) => finding.code === "source.roster.supplemented_from_record",
      ),
    ).toHaveLength(2);
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({
        endpoint: "record",
        rowIndex: 0,
        message: expect.stringContaining("pitchersBoxscore.home[0]"),
      }),
    );
    expect(raw).toEqual(before);
    expect(mapped.document.source.sourceBundleHash).toBe(hashRawGameBundle(before));
    expect(mapNaverGame(raw)).toEqual(mapped);
  });

  it("같은 ID의 타자·투수 기록은 한 선수로 합치고 박스스코어 타순·포지션은 선발에 쓰지 않는다", () => {
    const raw = bundle();
    object(recordRoot(raw).battersBoxscore).home = [
      { playerCode: "HP2", name: "홈구원", batorder: 4, pos: "지" },
    ];
    const mapped = mapNaverGame(raw);
    expect(
      mapped.document.rosters.home.players.filter((player) => player.playerId === "HP2"),
    ).toEqual([{ playerId: "HP2", name: "홈구원", starter: false, positions: ["투수"] }]);
  });

  it.each(["opponent_preview", "opponent_record", "name", "id_alias", "name_alias"])(
    "%s 충돌에서는 누락 선수를 임의 추가하지 않는다",
    (conflict) => {
      const raw = bundle();
      if (conflict === "opponent_preview")
        object(object(raw.payloads.lineup).awayTeamLineUp).batterCandidate = [
          { playerCode: "HP2", playerName: "홈구원" },
        ];
      if (conflict === "opponent_record")
        object(recordRoot(raw).battersBoxscore).away = [{ playerCode: "HP2", name: "홈구원" }];
      if (conflict === "name")
        object(recordRoot(raw).battersBoxscore).home = [{ playerCode: "HP2", name: "다른선수" }];
      if (conflict === "id_alias") pitcher(raw).playerCode = "OTHER";
      if (conflict === "name_alias") pitcher(raw).playerName = "다른선수";
      const mapped = mapNaverGame(raw);
      expect(mapped.document.rosters.home.players.some((player) => player.playerId === "HP2")).toBe(
        false,
      );
      expect(mapped.findings).toContainEqual(
        expect.objectContaining({
          code: "source.roster.identity_conflict",
          severity: "blocking",
          endpoint: "record",
        }),
      );
      expect(mapped.document.events.some((event) => event.kind === "unresolved")).toBe(true);
    },
  );

  it("이름이 없으면 중계에서 이름을 빌려 보완하지 않는다", () => {
    const raw = bundle();
    delete pitcher(raw).name;
    const mapped = mapNaverGame(raw);
    expect(mapped.document.rosters.home.players).toHaveLength(1);
    expect(mapped.findings).toContainEqual(
      expect.objectContaining({ code: "source.roster.identity_missing", severity: "blocking" }),
    );
  });

  it("같은 이름의 다른 ID를 합치지 않고 기존 로스터를 보존한다", () => {
    const raw = bundle();
    object(object(raw.payloads.lineup).homeTeamLineUp).pitcherBullpen = [
      { playerCode: "HP3", playerName: "홈구원", positionName: "투수" },
    ];
    const mapped = mapNaverGame(raw);
    expect(mapped.document.rosters.home.players.map((player) => player.playerId)).toEqual([
      "HP1",
      "HP3",
      "HP2",
    ]);
    expect(mapped.document.events[2]?.kind).toBe("substitution");
  });

  it.each([
    ["batter", "pitcher"],
    ["batters", "pitchers"],
  ])("legacy preview와 %s/%s record 별칭도 같은 근거로 보완한다", (batterKey, pitcherKey) => {
    const raw = bundle();
    const lineup = object(raw.payloads.lineup);
    for (const side of ["away", "home"]) {
      lineup[`${side}_starter`] = object(lineup[`${side}TeamLineUp`]).fullLineUp;
    }
    delete lineup.awayTeamLineUp;
    delete lineup.homeTeamLineUp;
    const record = recordRoot(raw);
    record[batterKey] = record.battersBoxscore;
    record[pitcherKey] = record.pitchersBoxscore;
    delete record.battersBoxscore;
    delete record.pitchersBoxscore;
    const mapped = mapNaverGame(raw);
    expect(mapped.document.rosters.home.players).toHaveLength(2);
    expect(mapped.findings.some((finding) => finding.severity === "blocking")).toBe(false);
  });
});
