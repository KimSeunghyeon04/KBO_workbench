import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  assertOwnedDatabase,
  capture,
  lockValidationRun,
} from "./analytics-validation-process.mjs";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("a validation run has one owner, including cleanup and resume", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kbo-validation-lock-"));
  const release = lockValidationRun(directory);
  try {
    assert.throws(() => lockValidationRun(directory), /already locked/);
  } finally {
    release();
  }
  const nextRelease = lockValidationRun(directory);
  nextRelease();
  nextRelease();
  rmdirSync(directory);
});

test("cleanup refuses a production container, a substituted ID, and missing ownership", () => {
  const name = "kbo-analysis-12345678-1234-1234-1234-123456789abc";
  const state = { kind: "kbo-analytics-validation-v1", container: name, containerId: "owned-id" };
  const inspection = { Id: "owned-id", Config: { Labels: { "kbo.analytics.validation": name } } };
  assert.doesNotThrow(() => assertOwnedDatabase(state, inspection));
  assert.throws(() =>
    assertOwnedDatabase({ ...state, container: "kbo-workbench-db-1" }, inspection),
  );
  assert.throws(() => assertOwnedDatabase(state, { ...inspection, Id: "another-id" }));
  assert.throws(() => assertOwnedDatabase(state, { ...inspection, Config: {} }));
});

test("subprocess arguments remain literal, and failure never appears successful", async () => {
  const literal = "spaces ' quotes \" $() `backticks` & | 한글";
  assert.equal(
    await capture(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal]),
    literal,
  );
  await assert.rejects(
    capture(process.execPath, ["-e", "process.stderr.write('expected failure');process.exit(7)"]),
    /expected failure/,
  );
});
