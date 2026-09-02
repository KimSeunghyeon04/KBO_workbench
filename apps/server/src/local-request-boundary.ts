import type { FastifyInstance } from "fastify";

const allowedHostnames = new Set(["127.0.0.1", "localhost", "api", "web"]);

export function installLocalRequestBoundary(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const host = hostnameFromHostHeader(request.headers.host ?? "");
    if (!allowedHostnames.has(host)) {
      await reply.code(403).send({ error: "허용되지 않은 Host입니다." });
      return;
    }
    const origin = request.headers.origin;
    if (origin === undefined) return;
    let originHostname = "";
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      await reply.code(403).send({ error: "유효하지 않은 Origin입니다." });
      return;
    }
    if (!allowedHostnames.has(originHostname)) {
      await reply.code(403).send({ error: "허용되지 않은 Origin입니다." });
    }
  });
}

function hostnameFromHostHeader(host: string): string {
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":", 1)[0] ?? "";
}
