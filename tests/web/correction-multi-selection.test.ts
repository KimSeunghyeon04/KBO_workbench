// @vitest-environment jsdom
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  CorrectionSessionCreateRequestSchema,
  parseCorrectionCommand,
  parseStagingGameDocumentV2,
} from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";
import { CorrectPage } from "../../apps/web/src/pages/correct-page.js";
import { makeDocument } from "../helpers/game-document.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

async function setup(grouped = false) {
  const temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-multi-selection-"));
  const workspace = await StagingWorkspace.open(temporary.path);
  const initialDocument = parseStagingGameDocumentV2(
    makeDocument([
      ...(grouped
        ? [
            { kind: "half_inning_start", payload: {}, relayText: "비식별 이닝 시작" },
            {
              kind: "batter_start",
              payload: { batterId: "a1", pitcherId: "hp1" },
              relayText: "비식별 타석 시작",
            },
          ]
        : []),
      ...Array.from({ length: 80 }, (_, index) => ({
        kind: "administrative",
        payload: { code: "announcement" },
        relayText: `비식별 중계 ${index}`,
      })),
    ]),
  );
  const document = parseStagingGameDocumentV2({
    ...initialDocument,
    metadata: { ...initialDocument.metadata, gameId: "20260820WOHH0" },
  });
  await workspace.saveReady(document, []);
  const manager = new CorrectionSessionManager(workspace);
  const initialSessionRequest = Promise.withResolvers<undefined>();
  let sessionId = "";
  let rejectNext = false;
  const commands: ReturnType<typeof parseCorrectionCommand>[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown;
    if (url.pathname === "/api/v2/correction-games")
      return Response.json(await workspace.correctionGameCatalog());
    if (url.pathname === "/api/v2/correction-sessions" && init?.method === "POST") {
      try {
        const opened = await manager.create(
          Value.Decode(CorrectionSessionCreateRequestSchema, payload),
        );
        sessionId = opened.sessionId;
        return Response.json(opened, { status: 201 });
      } finally {
        initialSessionRequest.resolve(undefined);
      }
    }
    if (parts[3] === undefined) throw new Error(`unexpected request ${url.pathname}`);
    const id = parts[3];
    if (parts[4] === "original") return Response.json(await manager.original(id));
    if (parts[4] === "source-evidence")
      return Response.json({
        eventId: parts[5],
        endpoint: "test-relay",
        blockIndex: 0,
        eventIndex: 0,
        relayRows: [],
        trackingRows: [],
      });
    if (init?.method === "DELETE") {
      await manager.delete(id, Number(url.searchParams.get("expectedSessionVersion")));
      return new Response(null, { status: 204 });
    }
    const body = Value.Decode(contractsFor(parts[4]), payload);
    if (parts[4] === "commands" && "command" in body && "apply" in body) {
      if (rejectNext) {
        rejectNext = false;
        return Response.json(
          {
            requestId: "test-conflict",
            code: "stale_session",
            category: "domain",
            message: "비식별 버전 충돌",
            retryable: false,
            details: [],
          },
          { status: 409 },
        );
      }
      const command = parseCorrectionCommand(body.command);
      commands.push(command);
      return Response.json(
        await manager.command(id, body.expectedSessionVersion, command, body.apply),
      );
    }
    if (parts[4] === "undo" || parts[4] === "redo")
      return Response.json(await manager[parts[4]](id, body.expectedSessionVersion));
    throw new Error(`unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/correct?scope=ready"] },
      createElement(QueryClientProvider, { client }, createElement(CorrectPage)),
    ),
  );
  const user = userEvent.setup();
  await waitFor(() =>
    expect((screen.getByLabelText("경기") as HTMLSelectElement).value).toBe(
      "staging:20260820WOHH0",
    ),
  );
  await user.click(await screen.findByRole("button", { name: "작업 사본 열기" }));
  await initialSessionRequest.promise;
  await screen.findByRole("region", { name: "선택한 행 작업" });
  const row = (index: number) => {
    const element = view.container.querySelector<HTMLElement>(
      `[id="ledger-event-select-e${index}"]`,
    );
    if (element === null) throw new Error(`row ${index} not visible`);
    return element;
  };
  return {
    user,
    row,
    view,
    commands,
    document,
    current: () => manager.get(sessionId),
    rejectNext: () => {
      rejectNext = true;
    },
    async [Symbol.asyncDispose]() {
      view.unmount();
      client.clear();
      manager.close();
      await workspace.close();
      await temporary[Symbol.asyncDispose]();
    },
  };
}
import { CorrectionCommandRequestSchema, CorrectionVersionRequestSchema } from "@kbo/contracts";
function contractsFor(operation: string | undefined) {
  return operation === "commands" ? CorrectionCommandRequestSchema : CorrectionVersionRequestSchema;
}
function summary() {
  return within(screen.getByRole("region", { name: "선택한 행 작업" })).getByRole("status")
    .textContent;
}

describe("보정 타임라인 다중 행 조작", () => {
  it("사본을 연 뒤 접힌 경기 선택 영역 밖에 해당 경기의 KBO 링크를 표시한다", async () => {
    await using test = await setup();
    const source = screen.getByText("다른 경기 선택").closest("details");
    expect(source?.open).toBe(false);
    const gameSummary = screen.getByRole("region", { name: "현재 보정 경기" });
    const live = within(gameSummary).getByRole("link", { name: "KBO 문자중계" });
    expect(live.getAttribute("href")).toBe(
      "https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20260820WOHH0&gyear=2026",
    );
    expect(live.getAttribute("target")).toBe("_blank");
    expect(live.getAttribute("rel")).toBe("noopener noreferrer");
    await test.user.click(screen.getByText("다른 경기 선택"));
    expect(screen.getAllByRole("link", { name: "KBO 문자중계" })).toHaveLength(1);
  });

  it("행별 이닝 접기·펼치기도 여러 행 선택을 보존한다", async () => {
    await using test = await setup(true);
    fireEvent.click(test.row(3));
    fireEvent.click(test.row(5), { ctrlKey: true });
    await test.user.click(screen.getByRole("button", { name: "1회초 이닝 접기", exact: true }));
    expect(summary()).toContain("2행 선택");
    expect(summary()).toContain("숨겨진 2행 포함");
    await test.user.click(screen.getByRole("button", { name: "1회초 이닝 펼치기", exact: true }));
    expect(summary()).toContain("2행 선택");
    expect(summary()).not.toContain("숨겨진");
    expect(test.commands).toHaveLength(0);
  });

  it("체크박스 없이 Ctrl·Shift·Ctrl+Shift 선택과 키보드를 지원한다", async () => {
    await using test = await setup();
    fireEvent.click(test.row(2));
    fireEvent.click(test.row(4), { ctrlKey: true });
    expect(summary()).toContain("2행 선택");
    fireEvent.click(test.row(7), { shiftKey: true });
    expect(summary()).toContain("4행 선택");
    fireEvent.keyDown(test.row(7), { key: "Home", ctrlKey: true, shiftKey: true });
    expect(summary()).toContain("8행 선택");
    fireEvent.click(test.row(0), { ctrlKey: true });
    expect(summary()).toContain("7행 선택");
    fireEvent.click(test.row(4), { metaKey: true });
    expect(summary()).toContain("6행 선택");
    fireEvent.click(test.row(3));
    fireEvent.click(test.row(5), { ctrlKey: true });
    expect(summary()).toContain("2행 선택");
    fireEvent.keyDown(test.row(5), { key: "ArrowDown", shiftKey: true });
    expect(summary()).toContain("2행 선택");
    fireEvent.keyDown(test.row(6), { key: " ", ctrlKey: true });
    expect(summary()).toContain("1행 선택");
    expect(test.view.container.querySelectorAll(".event-row input[type=checkbox]")).toHaveLength(0);
    expect(screen.queryByText(/Ctrl\/Command 클릭:/)).toBeNull();
  });

  it("불연속 행을 한 번에 삭제하고 한 번의 undo/redo로 원장을 복구한다", async () => {
    await using test = await setup();
    fireEvent.click(test.row(2));
    fireEvent.click(test.row(4), { ctrlKey: true });
    fireEvent.click(test.row(6), { ctrlKey: true });
    await test.user.click(screen.getByRole("button", { name: "선택 행 삭제" }));
    expect(test.current().sessionVersion).toBe(0);
    await test.user.click(screen.getByRole("button", { name: "3행 삭제", exact: true }));
    await waitFor(() => expect(test.current().draftDocument.events).toHaveLength(77));
    expect(test.commands).toMatchObject([{ kind: "delete_events", eventIds: ["e2", "e4", "e6"] }]);
    expect(test.current().sessionVersion).toBe(1);
    await test.user.click(screen.getByRole("button", { name: "실행 취소", exact: true }));
    await waitFor(() => expect(test.current().draftDocument).toEqual(test.document));
    await test.user.click(screen.getByRole("button", { name: "다시 실행", exact: true }));
    await waitFor(() => expect(test.current().draftDocument.events).toHaveLength(77));
  });

  it("선택한 행을 원장 순서대로 이동하고 자기 범위 목적지를 막는다", async () => {
    await using test = await setup();
    fireEvent.click(test.row(4));
    fireEvent.click(test.row(2), { ctrlKey: true });
    await test.user.click(screen.getByRole("button", { name: "선택 행 이동" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "이 행 앞으로 이동" }), {
      target: { value: "3" },
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "이동 적용" }).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "이 행 앞으로 이동" }), {
      target: { value: "1" },
    });
    await test.user.click(screen.getByRole("button", { name: "이동 적용" }));
    await waitFor(() => expect(test.current().sessionVersion).toBe(1));
    expect(
      test
        .current()
        .draftDocument.events.slice(0, 5)
        .map((event) => event.identity.eventId),
    ).toEqual(["e2", "e4", "e0", "e1", "e3"]);
    expect(summary()).toContain("2행 선택");
    expect(test.commands).toMatchObject([
      { kind: "move_events", eventIds: ["e2", "e4"], beforeEventId: "e0" },
    ]);
    await test.user.click(screen.getByRole("button", { name: "실행 취소", exact: true }));
    await waitFor(() => expect(test.current().draftDocument).toEqual(test.document));
  });

  it("필터로 숨긴 canonical 범위도 선택 수와 삭제 확인에 표시한다", async () => {
    await using test = await setup();
    fireEvent.click(test.row(1));
    fireEvent.change(screen.getByRole("searchbox", { name: "원장 행 검색" }), {
      target: { value: "비식별 중계 7" },
    });
    fireEvent.click(test.row(7), { shiftKey: true });
    expect(summary()).toContain("7행 선택");
    expect(summary()).toContain("숨겨진 6행 포함");
    await test.user.click(screen.getByRole("button", { name: "선택 행 삭제" }));
    expect(screen.getByRole("group", { name: "선택 행 삭제 확인" }).textContent).toContain(
      "숨겨진 6행도 포함",
    );
    await test.user.click(
      within(screen.getByRole("group", { name: "선택 행 삭제 확인" })).getByRole("button", {
        name: "취소",
      }),
    );
    expect(test.commands).toHaveLength(0);
    expect(test.current().draftDocument).toEqual(test.document);
  });

  it("실패한 명령은 원장과 선택을 유지하고 가상 목록 밖 선택도 지원한다", async () => {
    await using test = await setup();
    fireEvent.click(test.row(1));
    fireEvent.click(test.row(3), { ctrlKey: true });
    test.rejectNext();
    await test.user.click(screen.getByRole("button", { name: "선택 행 삭제" }));
    await test.user.click(screen.getByRole("button", { name: "2행 삭제", exact: true }));
    await screen.findByText("비식별 버전 충돌");
    expect(test.current().draftDocument).toEqual(test.document);
    expect(summary()).toContain("2행 선택");
    fireEvent.click(test.row(1));
    fireEvent.keyDown(test.row(1), { key: "End", shiftKey: true });
    expect(summary()).toContain("79행 선택");
    expect(test.view.container.querySelectorAll(".event-row").length).toBeLessThan(30);
  });
});
