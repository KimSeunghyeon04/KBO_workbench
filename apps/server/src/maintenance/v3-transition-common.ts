import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function assertV2TransitionPreflight(
  workspaceRoot: string,
  backupDirectory: string,
): Promise<void> {
  await assertBackup(backupDirectory);
  try {
    await access(path.join(workspaceRoot, ".writer.lock"));
    throw new Error("workspace writer lock이 존재합니다. API/writer를 중지한 뒤 다시 실행하세요.");
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const journals = await readdir(path.join(workspaceRoot, "journals"), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const active = journals.filter((entry) => entry.isFile());
  if (active.length > 0) {
    throw new Error(
      `미처리 journal이 있어 V3 전환을 시작하지 않습니다: ${active.map((item) => item.name).join(",")}`,
    );
  }
}

async function assertBackup(directory: string): Promise<void> {
  const value = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("backup manifest가 객체가 아닙니다.");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.formatVersion !== 1 || typeof manifest.migrationVersion !== "string") {
    throw new Error("지원하지 않는 backup manifest입니다.");
  }
  if (manifest.migrationVersion !== "0002_tracking_source_ordinal_nullable") {
    throw new Error("V2 최종 migration backup만 V3 전환 source로 사용할 수 있습니다.");
  }
  for (const key of ["database", "workspace"] as const) {
    const section = manifest[key];
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new Error(`backup ${key} manifest가 잘못되었습니다.`);
    }
    const record = section as Record<string, unknown>;
    if (typeof record.file !== "string" || !/^[0-9a-f]{64}$/.test(String(record.sha256))) {
      throw new Error(`backup ${key} 파일 정보가 잘못되었습니다.`);
    }
    const actual = await fileSha256(path.join(directory, record.file));
    if (actual !== record.sha256) throw new Error(`backup ${key} hash가 다릅니다.`);
  }
}

async function fileSha256(target: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
