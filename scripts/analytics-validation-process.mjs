import { spawn } from "node:child_process";
import { createWriteStream, openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// Arguments are passed directly; database bytes never cross a text shell or enter memory in full.
export function launch(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code ?? signal})`));
    });
  });
  return { child, completion };
}

export async function capture(command, args) {
  const { child, completion } = launch(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "",
    error = "";
  child.stdout.setEncoding("utf8").on("data", (s) => {
    output += s;
  });
  child.stderr.setEncoding("utf8").on("data", (s) => {
    error += s;
  });
  try {
    await completion;
  } catch (cause) {
    throw new Error(error.slice(-4000), { cause });
  }
  return output.trim();
}

export async function logged(command, args, env, filename) {
  const { child, completion } = launch(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = createWriteStream(filename, { flags: "w" });
  const abort = () => child.kill();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  try {
    await completion;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await new Promise((resolve) => output.end(resolve));
  }
}

export async function copyDatabase(source, target, filename) {
  const sourceProcess = launch(
    "docker",
    [
      "exec",
      "-e",
      "PGOPTIONS=-c default_transaction_read_only=on",
      source.container,
      "pg_dump",
      "-U",
      source.user,
      "-d",
      source.database,
      "--no-owner",
      "--no-acl",
      "--no-tablespaces",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const targetProcess = launch(
    "docker",
    [
      "exec",
      "-i",
      target,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "kbo_validation",
      "-d",
      "kbo_validation",
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const output = createWriteStream(filename);
  sourceProcess.child.stderr.pipe(output, { end: false });
  targetProcess.child.stderr.pipe(output, { end: false });
  const abort = () => {
    sourceProcess.child.kill();
    targetProcess.child.kill();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await Promise.all([
      sourceProcess.completion,
      targetProcess.completion,
      pipeline(sourceProcess.child.stdout, targetProcess.child.stdin),
    ]);
  } catch (error) {
    abort();
    throw error;
  } finally {
    await Promise.allSettled([sourceProcess.completion, targetProcess.completion]);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await new Promise((resolve) => output.end(resolve));
  }
}

export function assertOwnedDatabase(state, inspection) {
  if (
    state.kind !== "kbo-analytics-validation-v1" ||
    !/^kbo-analysis-[a-f0-9-]{36}$/.test(state.container) ||
    inspection.Id !== state.containerId ||
    inspection.Config?.Labels?.["kbo.analytics.validation"] !== state.container
  )
    throw new Error("The target is not this validation run's isolated database");
}

export function lockValidationRun(directory) {
  const filename = path.join(directory, "run.lock");
  let descriptor;
  try {
    descriptor = openSync(filename, "wx");
  } catch (cause) {
    throw new Error(
      `Validation is already locked: ${filename}. If a process crashed, verify the recorded host/PID has stopped before removing that lock.`,
      { cause },
    );
  }
  writeFileSync(descriptor, JSON.stringify({ host: hostname(), pid: process.pid }));
  closeSync(descriptor);
  let released = false;
  return () => {
    if (!released) {
      unlinkSync(filename);
      released = true;
    }
  };
}

export async function validationCodeHash(root) {
  const hash = createHash("sha256");
  async function visit(directory) {
    for (const entry of (await readdir(path.join(root, directory), { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        hash.update(relative.replaceAll(path.sep, "/"));
        hash.update("\0");
        hash.update(await readFile(path.join(root, relative)));
        hash.update("\0");
      }
    }
  }
  for (const directory of [
    "apps/server/dist",
    "packages/contracts/dist",
    "packages/collection/dist",
    "packages/game-core/dist",
    "packages/persistence/dist",
  ])
    await visit(directory);
  return hash.digest("hex");
}
