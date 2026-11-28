import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { isMissing } from "./workspace-files.js";

interface Entry<T> {
  version: string;
  value: T;
  bytes: number;
}

export function jsonFileVersion({
  dev,
  ino,
  size,
  mtimeNs,
  ctimeNs,
}: BigIntStats): string | undefined {
  if (ino === 0n || mtimeNs === 0n || ctimeNs === 0n) return undefined;
  return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
}

/** Caches a verified JSON file only while the current opened file still has the same identity. */
export class VerifiedJsonFiles<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;

  public constructor(
    private readonly maxFiles: number,
    private readonly maxBytes: number,
  ) {}

  public async read(
    file: string,
    verify: (input: unknown) => T | undefined,
  ): Promise<T | undefined> {
    try {
      const handle = await open(file, "r");
      try {
        const stats = await handle.stat({ bigint: true });
        const version = jsonFileVersion(stats);
        const cached = this.entries.get(file);
        if (cached !== undefined && version === cached.version) {
          this.entries.delete(file);
          this.entries.set(file, cached);
          return structuredClone(cached.value);
        }
        const value = verify(JSON.parse(await handle.readFile("utf8")));
        if (
          value !== undefined &&
          version !== undefined &&
          stats.size <= BigInt(this.maxBytes) &&
          version === jsonFileVersion(await handle.stat({ bigint: true }))
        ) {
          const bytes = Number(stats.size);
          this.remove(file);
          this.entries.set(file, { version, value, bytes });
          this.bytes += bytes;
          while (this.entries.size > this.maxFiles || this.bytes > this.maxBytes) {
            const first = this.entries.keys().next().value;
            if (first === undefined) break;
            this.remove(first);
          }
        }
        return structuredClone(value);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissing(error)) {
        this.remove(file);
        return undefined;
      }
      throw error;
    }
  }

  private remove(file: string): void {
    const current = this.entries.get(file);
    if (current === undefined) return;
    this.bytes -= current.bytes;
    this.entries.delete(file);
  }
}
