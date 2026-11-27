import {
  CollectionJobCreatedSchema,
  CollectionJobListSchema,
  CollectionJobSchema,
  GameCatalogSchema,
  type CollectionJob,
  type CollectionJobCreateRequest,
  type CollectionJobCreated,
  type GameCatalog,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

export async function getCollectionJobs(): Promise<readonly CollectionJob[]> {
  return Value.Decode(CollectionJobListSchema, await requestJson("/api/v2/collection-jobs")).jobs;
}
export async function createCollectionJob(
  request: CollectionJobCreateRequest,
): Promise<CollectionJobCreated> {
  return Value.Decode(
    CollectionJobCreatedSchema,
    await requestJson("/api/v2/collection-jobs", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}
export async function cancelCollectionJob(jobId: string): Promise<CollectionJob> {
  return Value.Decode(
    CollectionJobSchema,
    await requestJson(`/api/v2/collection-jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  );
}
export async function getGameCatalog(): Promise<GameCatalog> {
  return Value.Decode(GameCatalogSchema, await requestJson("/api/v2/games"));
}
