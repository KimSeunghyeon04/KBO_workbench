import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";

import { inspectPlaywrightBrowser } from "@kbo/collection";
import type { FailureDiagnostic, SystemStatus, WorkspaceStatus } from "@kbo/contracts";
import type { Pool } from "pg";

import type { AppConfig } from "./config.js";
import { inspectDatabase } from "./database.js";

async function inspectWorkspace(path: string): Promise<WorkspaceStatus> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, fsConstants.R_OK | fsConstants.W_OK);
    return {
      writable: true,
      path,
      message: "Workspace를 읽고 쓸 수 있습니다.",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "알 수 없는 workspace 오류";
    return { writable: false, path, message };
  }
}

export async function buildSystemStatus(
  config: AppConfig,
  pool: Pool,
  recentFailures: readonly FailureDiagnostic[] = [],
): Promise<SystemStatus> {
  const [browser, database, workspace] = await Promise.all([
    inspectPlaywrightBrowser(),
    inspectDatabase(pool, config.expectedMigrationVersion),
    inspectWorkspace(config.workspacePath),
  ]);
  return {
    status: browser.installed && database.healthy && workspace.writable ? "ready" : "degraded",
    apiVersion: config.apiVersion,
    browser,
    database,
    workspace,
    recentFailures: [...recentFailures].slice(0, 20),
  };
}
