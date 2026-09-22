import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { parseSchedulePayload, type PlaywrightScheduleExplorer } from "@kbo/collection";
import {
  canonicalStringify,
  compareCanonicalStrings,
  CollectionDiscoveryCreateSchema,
  CollectionSelectionCreateSchema,
  CollectionScheduleEntriesSchema,
  type CollectionDateRange,
  type CollectionDiscovery,
  type CollectionDiscoveryCreate,
  type CollectionDiscoveryRecord,
  type CollectionGameSummary,
  type CollectionGamesQuery,
  type CollectionOverview,
  type CollectionOverviewQuery,
  type CollectionScheduleEntry,
  type CollectionSelectionCreate,
  type CollectionSelection,
  type CollectionHistoryRecord,
  type GameCatalog,
} from "@kbo/contracts";
import { type StagingWorkspace } from "@kbo/persistence";
import {
  IdempotencyConflictError,
  InvalidCollectionRequestError,
  JobNotFoundError,
} from "./jobs/collection-job-manager.js";
import {
  assertCollectionRange,
  collectionCounts,
  collectionInventory,
  inCollectionRange,
  pageOf,
} from "./collection-read-model.js";

interface DiscoveryTask {
  record: CollectionDiscoveryRecord;
  controller: AbortController;
  execution: Promise<void> | null;
}

export class CollectionOperationsService {
  private readonly tasks = new Map<string, DiscoveryTask>();
  private creation: Promise<unknown> = Promise.resolve();
  private closed = false;
  public constructor(
    private readonly explorer: Pick<PlaywrightScheduleExplorer, "discoverRange">,
    private readonly workspace: StagingWorkspace,
    private readonly databaseCatalog: (gameIds?: readonly string[]) => Promise<GameCatalog>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  public async restore(): Promise<void> {
    for (const record of await this.workspace.collection.discoveries()) {
      if (record.discovery.status === "queued" || record.discovery.status === "running") {
        record.discovery = {
          ...record.discovery,
          status: "failed",
          complete: false,
          finishedAt: this.now().toISOString(),
          error: "서버 재시작으로 일정 확인이 중단되었습니다. 다시 확인해 주세요.",
        };
        await this.workspace.collection.saveDiscovery(record);
      }
    }
  }

  public create(input: CollectionDiscoveryCreate): Promise<CollectionDiscovery> {
    const execution = this.creation.then(() => this.createSerial(input));
    this.creation = execution.catch(() => undefined);
    return execution;
  }
  private async createSerial(input: CollectionDiscoveryCreate): Promise<CollectionDiscovery> {
    if (this.closed) throw new InvalidCollectionRequestError("서버가 종료 중입니다.");
    const request = Value.Decode(CollectionDiscoveryCreateSchema, input);
    const range = { startDate: request.startDate, endDate: request.endDate };
    assertCollectionRange(range);
    const existing = (await this.workspace.collection.discoveries()).find(
      (record) => record.idempotencyKey === request.idempotencyKey,
    );
    if (existing !== undefined) {
      if (canonicalStringify(existing.discovery.range) !== canonicalStringify(range))
        throw new IdempotencyConflictError("같은 요청 키의 일정 범위가 다릅니다.");
      return existing.discovery;
    }
    const discovery: CollectionDiscovery = {
      discoveryId: this.newId(),
      range,
      status: "queued",
      createdAt: this.now().toISOString(),
      finishedAt: null,
      pageCount: 0,
      gameCount: 0,
      complete: false,
      error: null,
    };
    const task: DiscoveryTask = {
      record: { discovery, idempotencyKey: request.idempotencyKey },
      controller: new AbortController(),
      execution: null,
    };
    await this.workspace.collection.saveDiscovery(task.record);
    this.tasks.set(discovery.discoveryId, task);
    // Discovery tasks run sequentially so repeated range changes cannot launch unbounded browsers.
    this.pump();
    return structuredClone(discovery);
  }
  private pump(): void {
    if (
      this.closed ||
      [...this.tasks.values()].some((task) => task.record.discovery.status === "running")
    )
      return;
    const task = [...this.tasks.values()].find(
      (value) => value.record.discovery.status === "queued",
    );
    if (task === undefined) return;
    task.record.discovery = { ...task.record.discovery, status: "running" };
    task.execution = this.run(task).finally(() => this.pump());
  }
  private async run(task: DiscoveryTask): Promise<void> {
    const id = task.record.discovery.discoveryId;
    let entries: readonly CollectionScheduleEntry[] = [];
    try {
      await this.workspace.collection.saveDiscovery(task.record);
      const range = task.record.discovery.range;
      const discovered = await this.explorer.discoverRange(
        range.startDate,
        range.endDate,
        task.controller.signal,
        async (page, response) => {
          await this.workspace.collection.savePage(id, page, response);
          task.record.discovery.pageCount = page;
          if (response.status === 200) {
            const parsed = parseSchedulePayload(response.payload, range.startDate, range.endDate);
            entries = Value.Decode(CollectionScheduleEntriesSchema, [...entries, ...parsed.games]);
            task.record.discovery.gameCount = new Set(entries.map((entry) => entry.gameId)).size;
          }
          await this.workspace.collection.saveDiscovery(task.record);
        },
      );
      entries = Value.Decode(CollectionScheduleEntriesSchema, discovered);
      if (task.controller.signal.aborted) throw new Error("일정 확인을 취소했습니다.");
      await this.workspace.collection.saveEntries(id, entries);
      task.record.discovery = {
        ...task.record.discovery,
        status: "succeeded",
        complete: true,
        gameCount: entries.length,
        finishedAt: this.now().toISOString(),
      };
    } catch (error: unknown) {
      await this.workspace.collection.saveEntries(id, [
        ...new Map(entries.map((entry) => [entry.gameId, entry])).values(),
      ]);
      task.record.discovery = {
        ...task.record.discovery,
        status: task.controller.signal.aborted ? "cancelled" : "failed",
        complete: false,
        finishedAt: this.now().toISOString(),
        error: error instanceof Error ? error.message : "일정 확인에 실패했습니다.",
      };
    }
    await this.workspace.collection.saveDiscovery(task.record);
  }
  public async list(range: CollectionDateRange): Promise<{ discoveries: CollectionDiscovery[] }> {
    assertCollectionRange(range);
    return {
      discoveries: (await this.workspace.collection.discoveries())
        .map((record) => record.discovery)
        .filter(
          (discovery) =>
            discovery.range.startDate === range.startDate &&
            discovery.range.endDate === range.endDate,
        )
        .sort((a, b) => compareCanonicalStrings(b.createdAt, a.createdAt))
        .slice(0, 50),
    };
  }
  public async get(id: string): Promise<CollectionDiscovery> {
    const record = await this.workspace.collection.discovery(id);
    if (record === null) throw new JobNotFoundError("일정 조회를 찾을 수 없습니다.");
    return record.discovery;
  }
  public async cancel(id: string): Promise<CollectionDiscovery> {
    const task = this.tasks.get(id);
    if (task !== undefined) {
      task.controller.abort();
      if (task.record.discovery.status === "queued") {
        task.record.discovery = {
          ...task.record.discovery,
          status: "cancelled",
          finishedAt: this.now().toISOString(),
        };
        await this.workspace.collection.saveDiscovery(task.record);
      }
      await task.execution;
    }
    return this.get(id);
  }
  public async wait(id: string): Promise<CollectionDiscovery> {
    const task = this.tasks.get(id);
    while (task?.record.discovery.status === "queued")
      await new Promise<void>((resolve) => setImmediate(resolve));
    await task?.execution;
    return this.get(id);
  }
  public async close(): Promise<void> {
    this.closed = true;
    await this.creation;
    await Promise.all([...this.tasks.keys()].map((id) => this.cancel(id)));
  }
  public async inventory(
    id?: string,
    gameIds?: readonly string[],
  ): Promise<CollectionGameSummary[]> {
    const [schedule, workspace, database] = await Promise.all([
      id === undefined ? Promise.resolve([]) : this.workspace.collection.entries(id),
      this.workspace.catalog(gameIds),
      this.databaseCatalog(gameIds),
    ]);
    const known = await this.workspace.collection.knownGames(
      workspace.games
        .filter((game) => game.authority === "source_failure")
        .map((game) => game.gameId),
    );
    return collectionInventory(schedule, workspace.games, database.games, known);
  }
  public async overview(id: string, query: CollectionOverviewQuery): Promise<CollectionOverview> {
    const discovery = await this.get(id);
    const range = rangeFor(discovery, query);
    const inventory = await this.inventory(id);
    const games = inventory.filter((game) => inCollectionRange(game, range));
    const groupBy = query.groupBy ?? "month";
    const grouped = new Map<string, CollectionGameSummary[]>();
    for (const game of games) {
      if (game.gameDate === null) continue;
      const key = groupBy === "month" ? game.gameDate.slice(0, 7) : game.gameDate;
      const bucket = grouped.get(key) ?? [];
      bucket.push(game);
      grouped.set(key, bucket);
    }
    const groups: CollectionOverview["groups"] = [];
    let cursor = range.startDate;
    while (cursor <= range.endDate) {
      const date = new Date(`${cursor}T00:00:00Z`);
      const end =
        groupBy === "month"
          ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
              .toISOString()
              .slice(0, 10)
          : cursor;
      const endDate = end > range.endDate ? range.endDate : end;
      const groupRange = { startDate: cursor, endDate };
      groups.push({
        key: groupBy === "month" ? cursor.slice(0, 7) : cursor,
        ...groupRange,
        counts: collectionCounts(
          grouped.get(groupBy === "month" ? cursor.slice(0, 7) : cursor) ?? [],
          discovery.complete,
        ),
      });
      const next = new Date(`${endDate}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
    return {
      discovery,
      counts: collectionCounts(games, discovery.complete),
      groups,
      unknownDateCount: inventory.filter((game) => game.gameDate === null).length,
    };
  }
  public async games(id: string, query: CollectionGamesQuery) {
    const discovery = await this.get(id);
    const range = rangeFor(discovery, query);
    const search = query.search?.trim().toLocaleLowerCase("ko-KR") ?? "";
    const games = (await this.inventory(id)).filter(
      (game) =>
        (query.unknownDate === true ? game.gameDate === null : inCollectionRange(game, range)) &&
        (query.state === undefined || game.state === query.state) &&
        (search === "" ||
          `${game.label} ${game.gameId} ${game.gameDate ?? ""}`
            .toLocaleLowerCase("ko-KR")
            .includes(search)),
    );
    const page = pageOf(games, query.page, query.limit);
    return { games: page.items, total: page.total, page: page.page, limit: page.limit };
  }
  public async select(input: CollectionSelectionCreate): Promise<CollectionSelection> {
    const request = Value.Decode(CollectionSelectionCreateSchema, input);
    const discovery = await this.get(request.discoveryId);
    assertCollectionRange(request.range, discovery.range);
    if (request.target === "uncollected" && !discovery.complete)
      throw new InvalidCollectionRequestError(
        "일정 전체 확인이 끝난 뒤 미수집 경기를 선택할 수 있습니다.",
      );
    const candidates = (await this.inventory(request.discoveryId)).filter(
      (game) =>
        game.state === request.target &&
        (request.unknownDate === true
          ? game.gameDate === null
          : inCollectionRange(game, request.range)),
    );
    const ids = new Set(candidates.map((game) => game.gameId));
    if ([...request.gameIds, ...request.excludedGameIds].some((id) => !ids.has(id))) {
      throw new InvalidCollectionRequestError(
        "선택한 경기의 저장 상태가 바뀌었거나 대상 범위를 벗어났습니다. 현황을 새로 확인해 주세요.",
      );
    }
    const included = new Set(request.gameIds),
      excluded = new Set(request.excludedGameIds);
    const chosen = candidates.filter(
      (game) =>
        !excluded.has(game.gameId) &&
        (request.mode === "all_matching" || included.has(game.gameId)),
    );
    if (chosen.length > 50_000)
      throw new InvalidCollectionRequestError("수집 대상은 최대 50,000경기입니다.");
    const entries = [];
    for (const game of chosen)
      entries.push({ game, workspaceToken: await this.workspace.collectionToken(game.gameId) });
    const current = new Map(
      (await this.inventory(request.discoveryId)).map((game) => [game.gameId, game]),
    );
    if (
      entries.some(
        (entry) =>
          canonicalStringify(current.get(entry.game.gameId) ?? null) !==
          canonicalStringify(entry.game),
      )
    ) {
      throw new IdempotencyConflictError(
        "대상 확정 중 저장 상태가 바뀌었습니다. 다시 선택해 주세요.",
      );
    }
    const selection: CollectionSelection = {
      selectionId: this.newId(),
      createdAt: this.now().toISOString(),
      request,
      count: entries.length,
    };
    await this.workspace.collection.saveSelection({ selection, entries });
    return selection;
  }
  public async history(page?: number, limit?: number) {
    const pagination = pageOf([], page, limit);
    const result = await this.workspace.collection.historyPage(
      (pagination.page - 1) * pagination.limit,
      pagination.limit,
    );
    return { ...result, page: pagination.page, limit: pagination.limit };
  }
  public async historyRecord(id: string): Promise<CollectionHistoryRecord> {
    const record = await this.workspace.collection.history(id);
    if (record === null) throw new JobNotFoundError("보존된 수집 기록을 찾을 수 없습니다.");
    return record;
  }
  public async historyItems(id: string, page?: number, limit?: number, problemsOnly = false) {
    await this.historyRecord(id);
    const results = (await this.workspace.collection.results(id))
      .filter(
        (item) =>
          !problemsOnly || ["quarantined", "source_failure", "interrupted"].includes(item.outcome),
      )
      .sort(
        (a, b) =>
          compareCanonicalStrings(a.finishedAt, b.finishedAt) ||
          compareCanonicalStrings(a.gameId, b.gameId),
      );
    const slice = pageOf(results, page, limit);
    const current = new Map(
      (
        await this.inventory(
          undefined,
          slice.items.map((item) => item.gameId),
        )
      ).map((game) => [game.gameId, game]),
    );
    return {
      items: slice.items.map((result) => ({ result, current: current.get(result.gameId) ?? null })),
      total: slice.total,
      page: slice.page,
      limit: slice.limit,
    };
  }
}

function rangeFor(
  discovery: CollectionDiscovery,
  query: { startDate?: string; endDate?: string },
): CollectionDateRange {
  const range = {
    startDate: query.startDate ?? discovery.range.startDate,
    endDate: query.endDate ?? discovery.range.endDate,
  };
  assertCollectionRange(range, discovery.range);
  return range;
}
