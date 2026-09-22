// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStagingGameDocumentV2, type CorrectionSession } from "@kbo/contracts";
import {
  useOwnedSession,
  rememberedCorrectionSessionId,
} from "../../apps/web/src/correction/use-owned-session.js";
import { makeDocument } from "../helpers/game-document.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function session(dirty = false): CorrectionSession {
  return {
    sessionId: "anonymous-session",
    sessionVersion: 0,
    gameId: "test-game",
    authority: "staging",
    baseDocumentHash: "0".repeat(64),
    draftDocumentHash: "0".repeat(64),
    draftDocument: parseStagingGameDocumentV2(makeDocument([])),
    dirty,
    canUndo: dirty,
    canRedo: false,
    blockingCount: 0,
    warningCount: 0,
    storedFindings: [],
    findings: [],
    eventContexts: [],
    calculatedRecords: { batters: [], pitchers: [] },
  };
}
function setup() {
  const client = new QueryClient();
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useOwnedSession(), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  return { ...hook, fetch, client };
}
describe("owned correction sessions", () => {
  it("releases a clean session once when leaving and removes its query data", async () => {
    const { result, unmount, fetch, client } = setup();
    const value = session();
    client.setQueryData(["correction", value.sessionId, "original"], value.draftDocument);
    act(() => result.current.setSession(value));
    globalThis.dispatchEvent(new Event("pagehide"));
    unmount();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(["correction", value.sessionId, "original"])).toBeUndefined();
    client.clear();
  });
  it("retains unsaved work and remembers only its server session ID when leaving", () => {
    const { result, unmount, fetch, client } = setup();
    act(() => result.current.setSession(session(true)));
    unmount();
    expect(fetch).not.toHaveBeenCalled();
    expect(rememberedCorrectionSessionId()).toBe("anonymous-session");
    client.clear();
  });
  it("releases a late clean creation and uses the latest version for an explicit close", async () => {
    const { result, unmount, fetch, client } = setup();
    const value = { ...session(true), sessionVersion: 7 };
    act(() => result.current.setSession(value));
    await act(async () => {
      await result.current.release(value);
      result.current.setSession(null);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      expect.stringContaining("expectedSessionVersion=7"),
      expect.objectContaining({ method: "DELETE" }),
    ]);
    expect(rememberedCorrectionSessionId()).toBeNull();
    const setSession = result.current.setSession;
    unmount();
    act(() => setSession(session()));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    client.clear();
  });
});
