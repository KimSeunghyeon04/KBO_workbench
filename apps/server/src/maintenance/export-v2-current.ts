import path from "node:path";

import {
  V2CurrentRevisionExporter,
  V3TransferWorkspace,
  type V3TransferGameManifest,
} from "@kbo/persistence";
import { Pool } from "pg";

import { assertV2TransitionPreflight } from "./v3-transition-common.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await assertV2TransitionPreflight(options.workspaceRoot, options.backupDirectory);
  const target = new V3TransferWorkspace(options.outputDirectory);
  await target.initializeEmpty();
  const pool = new Pool({ connectionString: options.sourceDsn, max: 2 });
  const entries: V3TransferGameManifest[] = [];
  try {
    const count = await new V2CurrentRevisionExporter(pool).exportCurrent(async (game) => {
      entries.push(await target.writeGame(game));
      if (entries.length % 50 === 0)
        process.stdout.write(`V2 current export ${String(entries.length)} games\n`);
    });
    const manifest = await target.writeManifest(entries);
    if (manifest.gameCount !== count) throw new Error("V2 export count가 manifest와 다릅니다.");
    process.stdout.write(
      `V2 current export 완료: ${String(count)} games -> ${options.outputDirectory}\n`,
    );
  } finally {
    await pool.end();
  }
}

interface Options {
  readonly sourceDsn: string;
  readonly workspaceRoot: string;
  readonly backupDirectory: string;
  readonly outputDirectory: string;
}

function parseOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) usage();
    values.set(name, value);
  }
  const sourceDsn = values.get("--source-dsn") ?? process.env.V2_DATABASE_URL;
  const backupDirectory = values.get("--backup");
  const outputDirectory = values.get("--output");
  if (sourceDsn === undefined || backupDirectory === undefined || outputDirectory === undefined)
    usage();
  return {
    sourceDsn,
    workspaceRoot: path.resolve(values.get("--workspace") ?? process.env.WORKSPACE_ROOT ?? ".data"),
    backupDirectory: path.resolve(backupDirectory),
    outputDirectory: path.resolve(outputDirectory),
  };
}

function usage(): never {
  throw new Error(
    "사용법: db:v3:export-current -- --source-dsn <V2 DSN> --backup <V2 backup dir> --output <export dir> [--workspace <.data>]",
  );
}

await main();
