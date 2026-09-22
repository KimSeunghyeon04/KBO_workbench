import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { createRuntime } from "./runtime.js";
import { createStartupServer } from "./startup-server.js";
import type { RequestListener } from "node:http";

const config = loadConfig();
const pool = createDatabasePool(config);
const startup = createStartupServer();
let app: ReturnType<typeof createApp> | undefined;
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  stopping = true;
  if (app !== undefined) {
    app.log.info({ signal }, "종료 신호를 받았습니다.");
    await app.close();
    process.exit(0);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await new Promise<void>((resolve, reject) => {
    startup.server.once("error", reject);
    startup.server.listen({ host: config.host, port: config.port }, () => {
      startup.server.off("error", reject);
      resolve();
    });
  });
  const runtime = await createRuntime(config, pool);
  let handler: RequestListener | undefined;
  app = createApp(config, pool, runtime, (requestHandler) => {
    handler = requestHandler;
    return startup.server;
  });
  app.addHook("onClose", startup.close);
  await app.ready();
  if (stopping) await shutdown("startup cancelled");
  else {
    if (handler === undefined) throw new Error("HTTP request handler가 없습니다.");
    startup.activate(handler);
    app.log.info(
      { address: startup.server.address() },
      "경기 검증을 마치고 요청 처리를 시작합니다.",
    );
  }
} catch (error: unknown) {
  if (app !== undefined) {
    app.log.error(error);
    await app.close();
  } else {
    console.error(error);
    await startup.close();
    await pool.end();
  }
  process.exit(1);
}
