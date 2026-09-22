import { createServer, type RequestListener } from "node:http";
import { localRequestError } from "./local-request-boundary.js";

/** The listener stays responsive while the workspace is fully verified before handing off. */
export function createStartupServer() {
  let ready: RequestListener | undefined;
  const server = createServer((request, response) => {
    if (ready !== undefined) {
      ready(request, response);
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const error = localRequestError(request.headers.host, request.headers.origin);
    if (error !== null) {
      response.writeHead(403).end(JSON.stringify({ error }));
    } else if (request.method === "GET" && request.url === "/health/live") {
      response.end(JSON.stringify({ status: "ok" }));
    } else {
      response.setHeader("Retry-After", "2");
      response.writeHead(503).end(
        JSON.stringify(
          request.url === "/health/ready"
            ? { status: "unavailable" }
            : {
                code: "server_initializing",
                category: "persistence",
                retryable: true,
                message:
                  "서버가 저장된 경기의 무결성을 확인하고 있습니다. 잠시 후 자동으로 다시 조회합니다.",
                requestId: "startup",
                details: [],
              },
        ),
      );
    }
  });
  return {
    server,
    close: async (): Promise<void> => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
    activate: (handler: RequestListener) => {
      ready = handler;
    },
  };
}
