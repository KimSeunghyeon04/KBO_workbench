import { JobEventSchema, type JobEvent } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

export type CollectionRefreshTarget = "collectionJobs" | "catalog" | "dashboard";

export function decodeCollectionJobEvent(data: string): JobEvent {
  return Value.Decode(JobEventSchema, JSON.parse(data) as unknown);
}

export function collectionRefreshTargets(event: JobEvent): readonly CollectionRefreshTarget[] {
  if (
    event.type === "succeeded" ||
    event.type === "failed" ||
    event.type === "cancelled" ||
    (event.type === "game_completed" && event.payload.disposition !== "none")
  ) {
    return ["collectionJobs", "catalog", "dashboard"];
  }
  return ["collectionJobs"];
}
