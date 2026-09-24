import { compareCanonicalStrings, type CurrentWorkspaceEntry } from "@kbo/contracts";
import path from "node:path";
import type { WorkspaceCurrentStore } from "./workspace-current-store.js";
import {
  WorkspaceMigrationRequiredError,
  WorkspacePersistenceBlockedError,
} from "./workspace-errors.js";
import { readDirectoryIfPresent } from "./workspace-files.js";
import { isGameId } from "./workspace-path-policy.js";
import { WorkspaceValidationPool } from "./workspace-validation-pool.js";
import type { WorkspaceValidation } from "./workspace-validation.js";

export async function assertNoUnmigratedCurrentFiles(workspaceRoot: string): Promise<void> {
  let legacyCount = 0;
  for (const authority of ["staging", "quarantine"] as const) {
    const root = path.join(workspaceRoot, authority);
    for (const entry of await readDirectoryIfPresent(root)) {
      if (!entry.isDirectory()) continue;
      if (authority === "quarantine" && entry.name === "source-failures") continue;
      for (const file of await readDirectoryIfPresent(path.join(root, entry.name))) {
        if (file.isFile() && file.name.endsWith(".json") && !file.name.endsWith(".findings.json")) {
          legacyCount += 1;
        }
      }
    }
  }
  for (const file of await readDirectoryIfPresent(
    path.join(workspaceRoot, "quarantine", "source-failures"),
  )) {
    if (file.isFile() && file.name.endsWith(".json")) legacyCount += 1;
  }
  if (legacyCount > 0) {
    throw new WorkspaceMigrationRequiredError(
      `versioned current manifest가 없는 legacy current artifact ${String(legacyCount)}개가 있습니다. workspace:migrate를 먼저 실행하세요.`,
    );
  }
}

export async function assertWorkspaceIntegrity(
  root: string,
  currentStorage: Pick<WorkspaceCurrentStore, "requiredCurrentEntry" | "supersededCount">,
  onValidated: (
    current: CurrentWorkspaceEntry,
    result: WorkspaceValidation,
    supersededCount: number,
  ) => void,
): Promise<void> {
  const referenced = new Set<string>();
  const files = (await readDirectoryIfPresent(path.join(root, "current")))
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .sort((a, b) => compareCanonicalStrings(a.name, b.name));
  const validation = new WorkspaceValidationPool(files.length >= 64);
  const validate = async (file: (typeof files)[number]) => {
    const gameId = file.name.slice(0, -5);
    if (!isGameId(gameId)) {
      throw new WorkspacePersistenceBlockedError(
        `current manifest 파일 이름이 올바르지 않습니다: ${file.name}`,
      );
    }
    try {
      const current = await currentStorage.requiredCurrentEntry(gameId);
      const [result, supersededCount] = await Promise.all([
        validation.validate(root, current),
        currentStorage.supersededCount(gameId),
      ]);
      onValidated(current, result, supersededCount);
      referenced.add(current.artifactPath);
    } catch (error: unknown) {
      throw new WorkspacePersistenceBlockedError(
        `current manifest 무결성 검증에 실패했습니다: ${gameId}: ${errorMessage(error)}`,
      );
    }
  };
  try {
    for (let offset = 0; offset < files.length; offset += 16) {
      const results = await Promise.allSettled(files.slice(offset, offset + 16).map(validate));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
  } finally {
    await validation.close();
  }
  for (const gameDirectory of await readDirectoryIfPresent(path.join(root, "active"))) {
    if (!gameDirectory.isDirectory() || !isGameId(gameDirectory.name)) continue;
    for (const artifact of await readDirectoryIfPresent(
      path.join(root, "active", gameDirectory.name),
    )) {
      if (
        !artifact.isFile() ||
        (!artifact.name.endsWith(".document.json") && !artifact.name.endsWith(".failure.json"))
      )
        continue;
      const artifactPath = path.posix.join("active", gameDirectory.name, artifact.name);
      if (!referenced.has(artifactPath)) {
        throw new WorkspacePersistenceBlockedError(
          `journal 없이 current가 아닌 active artifact가 발견되었습니다: ${artifactPath}`,
        );
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
