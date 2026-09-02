import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

import { StagingGameDocumentV2Schema } from "../packages/contracts/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "schemas", "staging-game-document-v2.schema.json");
const prettierConfig = (await prettier.resolveConfig(target)) ?? {};
const generated = await prettier.format(JSON.stringify(StagingGameDocumentV2Schema), {
  ...prettierConfig,
  filepath: target,
});
const mode = process.argv[2];

if (mode === "--write") {
  await writeFile(target, generated, "utf8");
  process.stdout.write(`updated ${path.relative(root, target)}\n`);
} else if (mode === "--check") {
  const existing = await readFile(target, "utf8");
  if (existing !== generated) {
    process.stderr.write("StagingGameDocumentV2 JSON Schema가 TypeBox 계약과 다릅니다.\n");
    process.exitCode = 1;
  }
} else {
  process.stderr.write("usage: node scripts/game-document-schema.mjs --write|--check\n");
  process.exitCode = 2;
}
