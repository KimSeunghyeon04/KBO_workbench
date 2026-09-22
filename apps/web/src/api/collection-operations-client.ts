import { Value } from "@sinclair/typebox/value";
import { type Static, type TSchema } from "@sinclair/typebox";
import { queryOptions } from "@tanstack/react-query";
import {
  CollectionDiscoverySchema,
  CollectionDiscoveryListSchema,
  CollectionOverviewSchema,
  CollectionGamePageSchema,
  CollectionSelectionSchema,
  CollectionHistoryPageSchema,
  CollectionHistoryRecordSchema,
  CollectionHistoryItemsSchema,
  CollectionJobListSchema,
  type CollectionDateRange,
  type CollectionDiscoveryCreate,
  type CollectionGamesQuery,
  type CollectionOverviewQuery,
  type CollectionSelectionCreate,
} from "@kbo/contracts";
import { requestJson } from "./transport";

const root = "/api/v2";
const idPath = (id: string) => `${root}/collection-discoveries/${encodeURIComponent(id)}`;
export const collectionOperationKey = ["collection-operations"] as const;
function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return params.toString();
}
async function get<S extends TSchema>(
  path: string,
  schema: S,
  signal: AbortSignal,
): Promise<Static<S>> {
  return Value.Decode(schema, await requestJson(path, { signal }));
}
export async function listDiscoveries(range: CollectionDateRange, signal?: AbortSignal) {
  return Value.Decode(
    CollectionDiscoveryListSchema,
    await requestJson(
      `${root}/collection-discoveries?${queryString(range)}`,
      signal === undefined ? undefined : { signal },
    ),
  );
}
export const discoveryListOptions = (range: CollectionDateRange) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "discoveries", range],
    queryFn: ({ signal }) => listDiscoveries(range, signal),
  });
export const discoveryOptions = (id: string) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "discovery", id],
    enabled: id !== "",
    queryFn: ({ signal }) => get(idPath(id), CollectionDiscoverySchema, signal),
  });
export const overviewOptions = (id: string, query: CollectionOverviewQuery) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "overview", id, query],
    enabled: id !== "",
    queryFn: ({ signal }) =>
      get(`${idPath(id)}/overview?${queryString(query)}`, CollectionOverviewSchema, signal),
  });
export const collectionGamesOptions = (id: string, query: CollectionGamesQuery) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "games", id, query],
    enabled: id !== "",
    queryFn: ({ signal }) =>
      get(`${idPath(id)}/games?${queryString(query)}`, CollectionGamePageSchema, signal),
  });
export const activeCollectionOptions = () =>
  queryOptions({
    queryKey: [...collectionOperationKey, "active"],
    queryFn: ({ signal }) =>
      get(`${root}/collection-jobs?activeOnly=true`, CollectionJobListSchema, signal),
  });
export const collectionHistoryOptions = (page: number) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "history", page],
    queryFn: ({ signal }) =>
      get(`${root}/collection-history?page=${page}&limit=50`, CollectionHistoryPageSchema, signal),
  });
export const collectionHistoryDetailOptions = (id: string) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "history-detail", id],
    enabled: id !== "",
    queryFn: ({ signal }) =>
      get(
        `${root}/collection-history/${encodeURIComponent(id)}`,
        CollectionHistoryRecordSchema,
        signal,
      ),
  });
export const collectionHistoryItemsOptions = (id: string, page: number, problemsOnly: boolean) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "history-items", id, page, problemsOnly],
    enabled: id !== "",
    queryFn: ({ signal }) =>
      get(
        `${root}/collection-history/${encodeURIComponent(id)}/games?${queryString({ page, limit: 50, problemsOnly })}`,
        CollectionHistoryItemsSchema,
        signal,
      ),
  });
export async function createDiscovery(request: CollectionDiscoveryCreate) {
  return Value.Decode(
    CollectionDiscoverySchema,
    await requestJson(`${root}/collection-discoveries`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}
export async function cancelDiscovery(id: string) {
  return Value.Decode(
    CollectionDiscoverySchema,
    await requestJson(idPath(id), { method: "DELETE" }),
  );
}
export async function createCollectionSelection(request: CollectionSelectionCreate) {
  return Value.Decode(
    CollectionSelectionSchema,
    await requestJson(`${root}/collection-selections`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}
