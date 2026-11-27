import { Value } from "@sinclair/typebox/value";
import { type Static, type TSchema } from "@sinclair/typebox";
import { hashKey, queryOptions } from "@tanstack/react-query";
import {
  CollectionDiscoverySchema,
  CollectionDiscoveryListSchema,
  CollectionViewSchema,
  CollectionSelectionSchema,
  CollectionHistoryPageSchema,
  CollectionHistoryRecordSchema,
  CollectionHistoryItemsSchema,
  CollectionJobListSchema,
  type CollectionDateRange,
  type CollectionDiscovery,
  type CollectionDiscoveryCreate,
  type CollectionViewQuery,
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
export const collectionViewOptions = (
  id: string,
  status: CollectionDiscovery["status"],
  query: CollectionViewQuery,
) =>
  queryOptions({
    queryKey: [...collectionOperationKey, "view", id, query, status] as const,
    enabled: id !== "",
    refetchOnMount: "always",
    queryFn: async ({ signal }) =>
      Value.Decode(
        CollectionViewSchema,
        await requestJson(`${idPath(id)}/view`, {
          method: "POST",
          signal,
          body: JSON.stringify(query),
        }),
      ),
    placeholderData: (previous, previousQuery) => {
      const previousScope = previousQuery?.queryKey[3];
      if (
        previous === undefined ||
        previousQuery?.queryKey[2] !== id ||
        previousQuery?.queryKey[4] !== status ||
        previousScope === undefined ||
        hashKey([previousScope.overview, previousScope.eligibility]) !==
          hashKey([query.overview, query.eligibility])
      )
        return undefined;
      return { overview: previous.overview, eligibleTotal: previous.eligibleTotal };
    },
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
export const collectionHistoryItemsKey = (id: string) =>
  [...collectionOperationKey, "history-items", id] as const;
export const collectionHistoryItemsOptions = (id: string, page: number, problemsOnly: boolean) =>
  queryOptions({
    queryKey: [...collectionHistoryItemsKey(id), page, problemsOnly],
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
