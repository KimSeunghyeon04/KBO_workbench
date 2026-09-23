import { execFile } from "node:child_process";
import { copyFile, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads server computation adapters without initializing the executor", async () => {
  await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-computation-module-"));
  const adapterPath = path.join(temporary.path, "computation.ts");
  await copyFile("apps/server/src/computation.ts", adapterPath);
  // A missing/broken worker dependency must not prevent importing the HTTP-side adapters.
  await writeFile(
    path.join(temporary.path, "computation-executor.ts"),
    'throw new Error("executor was initialized");\n',
  );
  const script = `
    import assert from "node:assert/strict";
    const adapter = await import(${JSON.stringify(pathToFileURL(adapterPath).href)});
    assert.equal(typeof adapter.compileDocument, "function");
    await assert.rejects(adapter.inlineComputation.run({ kind: "warmup" }), /executor was initialized/);
    process.stdout.write("adapter isolated");
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { timeout: 10_000 },
  );
  expect(stdout).toBe("adapter isolated");
});
