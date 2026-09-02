import {
  DatabaseOverviewSchema,
  DashboardSummarySchema,
  SystemStatusSchema,
  type DatabaseOverview,
  type DashboardSummary,
  type SystemStatus,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

export async function getDashboard(): Promise<DashboardSummary> {
  return Value.Decode(DashboardSummarySchema, await requestJson("/api/v2/dashboard"));
}
export async function getSystemStatus(): Promise<SystemStatus> {
  return Value.Decode(SystemStatusSchema, await requestJson("/api/v2/system/status"));
}
export async function getDatabaseOverview(): Promise<DatabaseOverview> {
  return Value.Decode(DatabaseOverviewSchema, await requestJson("/api/v2/database/status"));
}
