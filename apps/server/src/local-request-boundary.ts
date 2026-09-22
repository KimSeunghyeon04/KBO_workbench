import type { FastifyInstance } from "fastify";

const allowedHostnames = new Set(["127.0.0.1", "localhost", "api", "web"]);

export function installLocalRequestBoundary(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const error = localRequestError(request.headers.host, request.headers.origin);
    if (error !== null) await reply.code(403).send({ error });
  });
}

export function localRequestError(
  host: string | undefined,
  origin: string | undefined,
): string | null {
  if (!allowedHostnames.has(hostnameFromHostHeader(host ?? ""))) return "허용되지 않은 Host입니다.";
  if (origin === undefined) return null;
  try {
    return allowedHostnames.has(new URL(origin).hostname) ? null : "허용되지 않은 Origin입니다.";
  } catch {
    return "유효하지 않은 Origin입니다.";
  }
}

function hostnameFromHostHeader(host: string): string {
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":", 1)[0] ?? "";
}
