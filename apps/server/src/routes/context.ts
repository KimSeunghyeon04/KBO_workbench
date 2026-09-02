import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import type { ReplayService } from "../replay-service.js";
import type { AppRuntime } from "../runtime.js";

export interface RouteContext {
  readonly config: AppConfig;
  readonly pool: Pool;
  readonly runtime: AppRuntime;
  readonly replayService: ReplayService;
}
