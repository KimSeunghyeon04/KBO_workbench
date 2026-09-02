// @vitest-environment jsdom

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isRosterPlayerId,
  PlayerPicker,
  playerCandidates,
  playerSideForRole,
} from "../../apps/web/src/correction/player-picker.js";

afterEach(() => cleanup());

describe("PlayerPicker", () => {
  it("반이닝 역할에 맞는 팀을 계산하고 roster ID만 인정한다", () => {
    const document = fixture();
    expect(playerSideForRole("top", "batter")).toBe("away");
    expect(playerSideForRole("top", "pitcher")).toBe("home");
    expect(playerSideForRole("bottom", "runner")).toBe("home");
    expect(playerSideForRole("bottom", "responsible_pitcher")).toBe("away");
    expect(isRosterPlayerId(document, "away", "b1")).toBe(true);
    expect(isRosterPlayerId(document, "home", "b1")).toBe(false);
  });

  it("이름·ID·팀·포지션·타순을 검색하고 우선 선수를 먼저 표시한다", () => {
    const document = fixture();
    const candidates = playerCandidates(document, "away", ["b2"]);
    expect(candidates[0]?.playerId).toBe("b2");
    const batter = candidates.find((candidate) => candidate.playerId === "b1");
    expect(batter?.label).toContain("Away Team");
    expect(batter?.searchText).toContain("b1");
    expect(batter?.searchText).toContain("left field");
    expect(batter?.searchText).toContain("1");
  });

  it("마우스와 키보드로 선택하고 Escape와 외부 클릭으로 닫는다", async () => {
    const document = fixture();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(PlayerPicker, {
        label: "Batter",
        document,
        side: "away",
        value: "",
        onChange,
      }),
    );
    const trigger = screen.getByRole("combobox", { name: "Batter" });
    await user.click(trigger);
    const search = screen.getByRole("searchbox", { name: /Batter/ });
    await user.type(search, "left field");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("b1");
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(trigger);
    await user.click(documentBody());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("선택적 빈 값과 명단 밖 기존 ID를 명확히 표시한다", async () => {
    const document = fixture();
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      createElement(PlayerPicker, {
        label: "Responsible pitcher",
        document,
        side: "home",
        value: "missing-player",
        optionalLabel: "Automatic",
        onChange,
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Responsible pitcher" }).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByText(/missing-player/)).toBeTruthy();
    view.rerender(
      createElement(PlayerPicker, {
        label: "Responsible pitcher",
        document,
        side: "home",
        value: "p1",
        optionalLabel: "Automatic",
        onChange,
      }),
    );
    await user.click(screen.getByRole("combobox", { name: "Responsible pitcher" }));
    await user.click(screen.getByRole("option", { name: "Automatic" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});

function fixture() {
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "picker-game",
      collectedAt: "2026-08-20T03:00:00.000Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "picker-game",
      season: 2026,
      gameDate: "2026-08-20",
      status: "scheduled",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "Away Team" },
      home: { teamId: "HOME", name: "Home Team" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: [
          {
            playerId: "b1",
            name: "First Batter",
            battingOrder: 1,
            starter: true,
            positions: ["left field"],
          },
          { playerId: "b2", name: "Reserve", starter: false, positions: ["infield"] },
        ],
      },
      home: {
        teamId: "HOME",
        players: [{ playerId: "p1", name: "Pitcher", starter: true, positions: ["pitcher"] }],
      },
    },
    events: [],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  });
}

function documentBody(): HTMLElement {
  return document.body;
}
