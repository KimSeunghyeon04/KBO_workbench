import { describe, expect, it, vi } from "vitest";
import { BoundedReadCache } from "../../apps/server/src/bounded-read-cache.js";

describe("verified read cache bounds", () => {
  it("allows snapshot callers to release connections before waiting for an existing result", async () => {
    let now = 0;
    const cache = new BoundedReadCache<number>(100, 2, 100, () => now);
    expect(cache.get("a")).toBeUndefined();
    const deferred = Promise.withResolvers<number>();
    const pending = cache.load("a", () => deferred.promise);
    expect(cache.get("a")).toBe(pending);
    deferred.resolve(3);
    await pending;
    expect(await cache.get("a")).toBe(3);
    now = 101;
    expect(cache.get("a")).toBeUndefined();
  });
  it("accepts worker-measured byte sizes without serializing cached payloads again", async () => {
    const value = {
      toJSON: () => {
        throw new Error("must not serialize");
      },
    };
    const read = vi.fn(async () => value);
    const cache = new BoundedReadCache<typeof value>(10, 2, 1000, undefined, () => 4);
    await cache.load("a", read);
    await cache.load("a", read);
    expect(read).toHaveBeenCalledTimes(1);
    const invalid = new BoundedReadCache<number>(10, 2, 1000, undefined, () => Number.NaN);
    await expect(invalid.load("a", async () => 1)).rejects.toThrow("byte size");
  });
  it("shares concurrent reads, retries failures and revalidates explicit refreshes", async () => {
    const cache = new BoundedReadCache<number>(100, 2, 100);
    const read = vi.fn(async () => 1);
    expect(await Promise.all([cache.load("a", read), cache.load("a", read)])).toEqual([1, 1]);
    await cache.load("a", read);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.load("a", read, true);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(
      cache.load(
        "a",
        async () => {
          throw new Error("corrupt");
        },
        true,
      ),
    ).rejects.toThrow("corrupt");
    await cache.load("a", read);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("evicts by age, bytes and LRU entry count", async () => {
    let now = 0;
    const cache = new BoundedReadCache<string>(10, 2, 100, () => now);
    const read = vi.fn(async () => "aa");
    await cache.load("a", read);
    await cache.load("b", read);
    await cache.load("a", read);
    await cache.load("c", read);
    await cache.load("b", read);
    expect(read).toHaveBeenCalledTimes(4);
    now = 100;
    await cache.load("b", read);
    expect(read).toHaveBeenCalledTimes(5);
    await cache.load("large", async () => "x".repeat(20));
    await cache.load("large", read);
    expect(read).toHaveBeenCalledTimes(6);
  });
  it("a read finishing after clear cannot repopulate or replace a newer entry", async () => {
    const cache = new BoundedReadCache<number>(100, 2, 100);
    const deferred = Promise.withResolvers<number>();
    const pending = cache.load("a", () => deferred.promise);
    cache.clear();
    await cache.load("a", async () => 2);
    deferred.resolve(1);
    expect(await pending).toBe(1);
    expect(await cache.load("a", async () => 3)).toBe(2);
  });
});
