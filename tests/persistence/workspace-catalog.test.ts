import { describe, expect, it, vi } from "vitest";
import type { GameCatalogItem } from "@kbo/contracts";

import { WorkspaceCatalog } from "../../packages/persistence/src/workspace-catalog.js";

function item(gameId: string, warningFindings = 0): GameCatalogItem {
  return {
    gameId,
    season: 2026,
    authority: "source_failure",
    updatedAt: "2026-09-13T00:00:00Z",
    blockingFindings: 1,
    warningFindings,
    supersededCount: 0,
  };
}

describe("workspace 표시 요약 인덱스", () => {
  it("10,000경기 목록의 반복·동시 조회는 파일을 다시 읽지 않는다", async () => {
    const load = vi.fn(async () => null);
    const catalog = new WorkspaceCatalog(load);
    for (let index = 9999; index >= 0; index -= 1)
      catalog.seed(item(`game-${String(index).padStart(5, "0")}`));
    const results = await Promise.all(Array.from({ length: 8 }, () => catalog.snapshot()));
    expect(results.every((result) => result.games.length === 10000)).toBe(true);
    expect(results[0]?.games[0]?.gameId).toBe("game-00000");
    expect(load).not.toHaveBeenCalled();
    expect(
      (await catalog.snapshot(["game-09999", "game-00002", "missing", "game-00002"])).games.map(
        (game) => game.gameId,
      ),
    ).toEqual(["game-00002", "game-09999"]);
    expect((await catalog.snapshot([])).games).toEqual([]);
  });

  it("여러 조회가 겹쳐도 바뀐 경기만 한 번 읽고 반환값 수정은 격리한다", async () => {
    const load = vi.fn(async (gameId: string) => item(gameId, 2));
    const catalog = new WorkspaceCatalog(load);
    catalog.seed(item("unchanged"));
    catalog.seed(item("changed"));
    catalog.invalidate("changed");
    const results = await Promise.all(Array.from({ length: 8 }, () => catalog.snapshot()));
    expect(load).toHaveBeenCalledExactlyOnceWith("changed");
    const returned = results[0]?.games[0];
    if (returned === undefined) throw new Error("목록 항목이 없습니다.");
    returned.warningFindings = 999;
    expect((await catalog.snapshot()).games[0]?.warningFindings).toBe(2);
  });

  it.each([false, true])(
    "조회 중 새 저장이 있으면 이전 결과·이동된 artifact 오류를 재사용하지 않는다 (읽기 실패=%s)",
    async (failOldRead) => {
      const first = Promise.withResolvers<GameCatalogItem | null>();
      const started = Promise.withResolvers<boolean>();
      const load = vi.fn(async () => {
        if (load.mock.calls.length === 1) {
          started.resolve(true);
          return first.promise;
        }
        return item("changed", 3);
      });
      const catalog = new WorkspaceCatalog(load);
      catalog.seed(item("changed"));
      catalog.invalidate("changed");
      const snapshot = catalog.snapshot();
      await started.promise;
      catalog.invalidate("changed");
      if (failOldRead) first.reject(new Error("old artifact moved"));
      else first.resolve(item("changed", 1));
      expect((await snapshot).games[0]?.warningFindings).toBe(3);
      expect(load).toHaveBeenCalledTimes(2);
      await catalog.snapshot();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it("삭제된 current는 목록에서 제거하고 실패한 읽기는 이전 표시로 숨기지 않는다", async () => {
    const load = vi
      .fn<(gameId: string) => Promise<GameCatalogItem | null>>()
      .mockRejectedValueOnce(new Error("invalid manifest"))
      .mockResolvedValueOnce(null);
    const catalog = new WorkspaceCatalog(load);
    catalog.seed(item("removed"));
    catalog.invalidate("removed");
    await expect(catalog.snapshot()).rejects.toThrow("invalid manifest");
    expect(await catalog.snapshot()).toEqual({ games: [] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("대량 변경 뒤 동시 조회도 전체 파일 읽기를 최대 16개로 제한한다", async () => {
    let active = 0,
      maximum = 0;
    const load = vi.fn(async (gameId: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return item(gameId);
    });
    const catalog = new WorkspaceCatalog(load);
    for (let index = 0; index < 100; index += 1) catalog.invalidate(`game-${String(index)}`);
    const results = await Promise.all(Array.from({ length: 8 }, () => catalog.snapshot()));
    expect(results.every((result) => result.games.length === 100)).toBe(true);
    expect(load).toHaveBeenCalledTimes(100);
    expect(maximum).toBe(16);
  });
});
