import { parentPort } from "node:worker_threads";
import { Value } from "@sinclair/typebox/value";

const helper = new URL(
  import.meta.url.endsWith(".ts") ? "./workspace-validation.ts" : "./workspace-validation.js",
  import.meta.url,
);
const {
  WorkspaceValidationRequestSchema,
  validateWorkspaceEntry,
}: typeof import("./workspace-validation.js") = await import(helper.href);
const port = parentPort;
if (port === null) throw new Error("Workspace validation worker requires a parent port");
port.on("message", (input: unknown) => {
  void (async () => {
    try {
      const { root, current } = Value.Decode(WorkspaceValidationRequestSchema, input);
      port.postMessage({ ok: true, result: await validateWorkspaceEntry(root, current) });
    } catch (error: unknown) {
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : "workspace 검증 실패",
      });
    }
  })();
});
