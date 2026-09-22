import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ApiErrorSchema } from "@kbo/contracts";
import Fastify from "fastify";
import { createStartupServer } from "../src/startup-server.js";

describe("startup HTTP handoff", () => {
  it("keeps liveness and local boundaries while rejecting work until validation completes", async () => {
    const startup = createStartupServer();
    startup.server.listen(0, "127.0.0.1");
    await once(startup.server, "listening");
    const address = startup.server.address();
    if (address === null || typeof address === "string") throw new Error("missing port");
    const url = `http://127.0.0.1:${String(address.port)}`;
    let activate = () => {
      throw new Error("missing request handler");
    };
    const app = Fastify({
      serverFactory: (handler) => {
        activate = () => startup.activate(handler);
        return startup.server;
      },
    });
    app.get("/health/ready", async () => "ready");
    app.addHook("onClose", startup.close);
    try {
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      expect((await fetch(`${url}/health/ready`)).status).toBe(503);
      expect(
        (await fetch(`${url}/api/v2/games`, { headers: { Origin: "https://evil.example" } }))
          .status,
      ).toBe(403);
      const blocked = await fetch(`${url}/api/v2/collection-jobs`, { method: "POST" });
      expect(blocked.status).toBe(503);
      expect(Value.Decode(ApiErrorSchema, await blocked.json())).toMatchObject({
        code: "server_initializing",
        retryable: true,
      });
      await app.ready();
      activate();
      expect(await (await fetch(`${url}/health/ready`)).text()).toBe("ready");
    } finally {
      await app.close();
    }
    expect(startup.server.listening).toBe(false);
  });
});
