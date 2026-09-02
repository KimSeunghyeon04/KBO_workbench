import { readFile } from "node:fs/promises";

import {
  KBO_REGISTRY_TEAMS,
  KboRegistryCollector,
  classifyTradeCategory,
  parseKboRegisterHtml,
  parseKboTradeResponse,
} from "@kbo/collection";
import { describe, expect, it, vi } from "vitest";

const registerFixture = new URL(
  "../fixtures/kbo-registry/register-sanitized.html",
  import.meta.url,
);
const tradeFixture = new URL("../fixtures/kbo-registry/trade-sanitized.json", import.meta.url);

describe("KBO registry parser", () => {
  it("공식 playerId와 당시 표시값만 선수 등록 snapshot으로 보존한다", async () => {
    const snapshot = parseKboRegisterHtml(
      await readFile(registerFixture, "utf8"),
      "2024-04-01",
      "SS",
      "삼성",
      "register:2024-04-01:SS",
    );

    expect(snapshot.complete).toBe(true);
    expect(snapshot.players.map((player) => player.playerId)).toEqual(["70001", "70002", "71001"]);
    expect(snapshot.players[0]).toMatchObject({
      playerName: "가선수",
      rosterCategory: "투수",
      uniformNumber: "11",
      birthDate: "1999-01-02",
      heightCm: 184,
      weightKg: 91,
    });
    expect(snapshot.players.some((player) => player.playerName === "코치가")).toBe(false);
  });

  it("시즌 개막 전 빈 명단도 4개 선수 분류 구조가 완전하면 유효한 snapshot으로 보존한다", () => {
    const emptyTables = ["투수", "포수", "내야수", "외야수"]
      .map(
        (category) =>
          `<table><thead><tr><th>등번호</th><th>${category}</th><th>투타유형</th><th>생년월일</th><th>체격</th></tr></thead><tbody><tr><td colspan="5">당일 1군 등록된 ${category}가 없습니다.</td></tr></tbody></table>`,
      )
      .join("");
    const snapshot = parseKboRegisterHtml(
      `<input name="x$hfSearchTeam" value="SS"><input name="x$hfSearchDate" value="20240309">${emptyTables}`,
      "2024-03-09",
      "SS",
      "삼성",
      "register:2024-03-09:SS",
    );

    expect(snapshot).toMatchObject({ complete: true, players: [] });
  });

  it("이적과 비소속 변경을 구분하고 모르는 분류는 원문과 함께 남긴다", async () => {
    const parsed = parseKboTradeResponse(
      JSON.parse(await readFile(tradeFixture, "utf8")) as unknown,
      "trade:2024:04:1",
      0,
    );

    expect(parsed.totalCount).toBe(5);
    expect(parsed.events.map((event) => [event.eventKind, event.affiliationEffect])).toEqual([
      ["trade", "transfer"],
      ["name_change", "none"],
      ["number_change", "none"],
      ["free_agent_release", "end"],
      ["unknown", "unknown"],
    ]);
    expect(parsed.events[0]).toMatchObject({
      rawPlayerName: "가선수",
      rawPosition: "투수",
      rawNote: "이전구단 → 새구단",
    });
    expect(classifyTradeCategory(" 개명 ")).toEqual({
      eventKind: "name_change",
      affiliationEffect: "none",
    });
  });
});

describe("KBO registry collector", () => {
  it("resume cache의 원문만 사용해 결정론적인 하루 dataset을 만든다", async () => {
    const register = await readFile(registerFixture, "utf8");
    const trade = await readFile(tradeFixture, "utf8");
    const client = {
      registerPage: vi.fn(() => Promise.reject(new Error("network must not be used"))),
      tradePage: vi.fn(() => Promise.reject(new Error("network must not be used"))),
    };
    const collector = new KboRegistryCollector(client as never);
    const result = await collector.collect({
      season: 2024,
      dateFrom: "2024-04-01",
      dateTo: "2024-04-01",
      concurrency: 3,
      sink: () => Promise.reject(new Error("sink must not be used for cached pages")),
      cache: (kind, key) =>
        Promise.resolve({
          body: kind === "register" ? register : trade,
          collectedAt: "2024-04-01T00:00:00.000Z",
          artifactKey: `cached/${key}`,
          contentHash: "a".repeat(64),
        }),
    });

    expect(client.registerPage).not.toHaveBeenCalled();
    expect(client.tradePage).not.toHaveBeenCalled();
    expect(result.dataset.registrationSnapshots).toHaveLength(KBO_REGISTRY_TEAMS.length);
    expect(result.dataset.sourcePages).toHaveLength(KBO_REGISTRY_TEAMS.length + 1);
    expect(result.dataset.statusEvents).toHaveLength(1);
    expect(result.dataset.statusEvents[0]?.eventKind).toBe("trade");
    expect(result.sourceBundleHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
