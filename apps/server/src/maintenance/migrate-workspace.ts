import path from "node:path";

import { canonicalStringify } from "@kbo/contracts";
import { migrateWorkspaceLayout } from "@kbo/persistence";

interface Arguments {
  readonly apply: boolean;
  readonly workspace: string;
  readonly backupDirectory?: string;
  readonly resolutionFile?: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const report = await migrateWorkspaceLayout({
    root: options.workspace,
    apply: options.apply,
    ...(options.backupDirectory === undefined ? {} : { backupDirectory: options.backupDirectory }),
    ...(options.resolutionFile === undefined ? {} : { resolutionFile: options.resolutionFile }),
  });
  process.stdout.write(`${canonicalStringify(report)}\n`);
}

function parseArguments(args: readonly string[]): Arguments {
  let mode: "dry-run" | "apply" | null = null;
  let workspace = path.resolve(process.env.KBO_DATA_DIR?.trim() || ".data");
  let backupDirectory: string | undefined;
  let resolutionFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      const nextMode = argument === "--apply" ? "apply" : "dry-run";
      if (mode !== null && mode !== nextMode) {
        throw new Error("--dry-run과 --apply는 동시에 사용할 수 없습니다.");
      }
      mode = nextMode;
      continue;
    }
    if (argument === "--workspace" || argument === "--backup" || argument === "--resolution") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} 값이 필요합니다.`);
      }
      index += 1;
      if (argument === "--workspace") workspace = path.resolve(value);
      if (argument === "--backup") backupDirectory = path.resolve(value);
      if (argument === "--resolution") resolutionFile = path.resolve(value);
      continue;
    }
    throw new Error(`알 수 없는 workspace migration 인수입니다: ${argument ?? ""}`);
  }
  if (mode === null) throw new Error("--dry-run 또는 --apply를 명시해야 합니다.");
  return {
    apply: mode === "apply",
    workspace,
    ...(backupDirectory === undefined ? {} : { backupDirectory }),
    ...(resolutionFile === undefined ? {} : { resolutionFile }),
  };
}

await main();
