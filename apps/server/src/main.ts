import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const pool = createDatabasePool(config);
const runtime = await createRuntime(config, pool);
const app = createApp(config, pool, runtime);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "종료 신호를 받았습니다.");
  await app.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error: unknown) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
