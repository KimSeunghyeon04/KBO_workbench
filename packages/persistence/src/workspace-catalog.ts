import {
  compareCanonicalStrings,
  type CurrentWorkspaceEntry,
  type GameCatalog,
  type GameCatalogItem,
  type StoredFinding,
} from "@kbo/contracts";

/** Disposable display index; authoritative document reads and write tokens still use files. */
export class WorkspaceCatalog {
  private readonly items = new Map<string, GameCatalogItem>();
  private readonly dirty = new Map<string, number>();
  private refreshing: Promise<void> | undefined;
  private generation = 0;

  public constructor(private readonly load: (gameId: string) => Promise<GameCatalogItem | null>) {}

  public seed(item: GameCatalogItem): void {
    this.items.set(item.gameId, structuredClone(item));
    this.dirty.delete(item.gameId);
  }

  public invalidate(gameId: string): void {
    this.generation += 1;
    this.dirty.set(gameId, this.generation);
  }

  public async snapshot(gameIds?: readonly string[]): Promise<GameCatalog> {
    while (this.dirty.size > 0) {
      await this.refresh();
    }
    return {
      games: structuredClone(
        (gameIds === undefined
          ? [...this.items.values()]
          : [...new Set(gameIds)].flatMap((id) => {
              const item = this.items.get(id);
              return item === undefined ? [] : [item];
            })
        ).sort(compareCatalogItems),
      ),
    };
  }

  private refresh(): Promise<void> {
    this.refreshing ??= Promise.resolve()
      .then(async () => {
        while (this.dirty.size > 0) {
          const batch = [...this.dirty.entries()].slice(0, 16);
          const results = await Promise.allSettled(
            batch.map(async ([gameId, generation]) => {
              try {
                const item = await this.load(gameId);
                // A concurrent transition may also move the artifact this read was opening.
                if (this.dirty.get(gameId) !== generation) return;
                if (item === null) this.items.delete(gameId);
                else this.items.set(gameId, item);
                this.dirty.delete(gameId);
              } catch (error: unknown) {
                if (this.dirty.get(gameId) === generation) throw error;
              }
            }),
          );
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
}

export function workspaceCatalogItem(
  current: CurrentWorkspaceEntry,
  findings: readonly StoredFinding[],
  supersededCount: number,
): GameCatalogItem {
  const common = {
    gameId: current.gameId,
    season: current.season,
    updatedAt: current.updatedAt,
    blockingFindings: findings.filter((finding) => finding.severity === "blocking").length,
    warningFindings: findings.filter((finding) => finding.severity === "warning").length,
    supersededCount,
  };
  if (current.authority === "source_failure") return { ...common, authority: "source_failure" };
  return {
    ...common,
    authority: current.authority === "ready" ? "staging" : "quarantine",
    ...current.displaySummary,
  };
}

function compareCatalogItems(left: GameCatalogItem, right: GameCatalogItem): number {
  return (
    compareCanonicalStrings(right.updatedAt, left.updatedAt) ||
    compareCanonicalStrings(left.gameId, right.gameId)
  );
}
