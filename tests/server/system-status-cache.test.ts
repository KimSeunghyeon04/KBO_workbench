import { describe, expect, it, vi } from "vitest";
import type { SystemStatus } from "@kbo/contracts";
import { createSystemStatusReader } from "../../apps/server/src/status.js";

const status: SystemStatus = {
  status: "ready",
  apiVersion: "v2",
  browser: { installed: true, version: null, executablePath: null, message: "ok" },
  database: {
    reachable: true,
    healthy: true,
    serverMajorVersion: 16,
    expectedServerMajorVersion: 16,
    migrationVersion: "v",
    expectedMigrationVersion: "v",
    message: "ok",
  },
  workspace: { writable: true, path: "anonymous", message: "ok" },
  recentFailures: [],
};
describe("shared display status checks", () => {
  it("shares concurrent polls, preserves an absolute expiry, and retries failed checks", async () => {
    let now = 0;
    const load = vi.fn(async () => status);
    const read = createSystemStatusReader(load, () => now);
    const [first] = await Promise.all([read(), read(), read()]);
    expect(load).toHaveBeenCalledTimes(1);
    if (first === undefined) throw new Error("missing status");
    first.database.healthy = false;
    for (now = 100; now < 500; now += 100) expect((await read()).database.healthy).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    await read();
    expect(load).toHaveBeenCalledTimes(2);
    now = 1000;
    load.mockRejectedValueOnce(new Error("unavailable"));
    await expect(read()).rejects.toThrow("unavailable");
    expect(await read()).toEqual(status);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
