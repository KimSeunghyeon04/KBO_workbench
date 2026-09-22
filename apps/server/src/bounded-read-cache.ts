interface Entry<T> {
  readonly value: T;
  readonly bytes: number;
  touchedAt: number;
}

/** Holds verified read results only; callers own validation, keys and response isolation. */
export class BoundedReadCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private bytes = 0;
  private generation = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly measure: (value: T) => number;

  public constructor(
    maxBytes: number,
    maxEntries: number,
    maxAgeMs: number,
    now: () => number = Date.now,
    measure: (value: T) => number = (value) => Buffer.byteLength(JSON.stringify(value), "utf8"),
  ) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.measure = measure;
  }

  public load(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      if (!refresh && this.now() - cached.touchedAt < this.maxAgeMs) {
        this.entries.delete(key);
        cached.touchedAt = this.now();
        this.entries.set(key, cached);
        return Promise.resolve(cached.value);
      }
      this.remove(key);
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const generation = this.generation;
    const result = Promise.resolve()
      .then(load)
      .then((value) => {
        const bytes = this.measure(value);
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid cache byte size");
        if (generation === this.generation && bytes <= this.maxBytes) {
          this.entries.set(key, { value, bytes, touchedAt: this.now() });
          this.bytes += bytes;
          while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.remove(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      });
    this.pending.set(key, result);
    return result;
  }

  /** Look up a freshly validated source key without starting a loader or holding its DB snapshot. */
  public get(key: string): Promise<T> | undefined {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      if (this.now() - cached.touchedAt < this.maxAgeMs) {
        this.entries.delete(key);
        cached.touchedAt = this.now();
        this.entries.set(key, cached);
        return Promise.resolve(cached.value);
      }
      this.remove(key);
    }
    return this.pending.get(key);
  }

  public clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
