import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  canonicalStringify,
  parseOfficialPlayerBirthYears,
  parseOfficialPlayerCareerDataset,
} from "@kbo/contracts";
import { ImmutableTextArtifactStore } from "./immutable-artifact-store.js";
import { atomicWrite, isMissing } from "./workspace-files.js";

type CareerSourceKind = "profile" | "move" | "movement" | "alias";

export class OfficialCareerWorkspace {
  public readonly sources: ImmutableTextArtifactStore<CareerSourceKind>;

  public constructor(
    private readonly root: string,
    runId: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error("잘못된 선수 경력 수집 ID");
    this.sources = new ImmutableTextArtifactStore({
      root,
      artifactKey: (kind, key) => {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error("잘못된 선수 경력 원문 키");
        const extension = kind === "movement" ? "json" : "html";
        return path.posix.join(
          "registry",
          "player-careers",
          "source",
          runId,
          kind,
          `${key}.${extension}.gz`,
        );
      },
      isPageKind: (value): value is CareerSourceKind =>
        value === "profile" || value === "move" || value === "movement" || value === "alias",
      mismatchMessage: (key) => `선수 경력 원문과 해시가 일치하지 않습니다. ${key}`,
    });
  }

  public async publish(input: unknown): Promise<void> {
    const result = parseOfficialPlayerCareerDataset(input);
    await atomicWrite(
      this.root,
      careerPath(this.root, "verified.json"),
      `${canonicalStringify(result)}\n`,
    );
  }

  public async publishBirthYears(input: unknown): Promise<void> {
    const result = parseOfficialPlayerBirthYears(input);
    await atomicWrite(
      this.root,
      careerPath(this.root, "birth-years.json"),
      `${canonicalStringify(result)}\n`,
    );
  }
}

export function readOfficialPlayerCareers(root: string) {
  return readRecords(careerPath(root, "verified.json"), parseOfficialPlayerCareerDataset);
}

export function readOfficialPlayerBirthYears(root: string) {
  return readRecords(careerPath(root, "birth-years.json"), parseOfficialPlayerBirthYears);
}

async function readRecords<T>(file: string, parse: (input: unknown) => { records: T[] }) {
  try {
    return parse(JSON.parse(await readFile(file, "utf8"))).records;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function careerPath(root: string, filename: string) {
  return path.join(root, "registry", "player-careers", filename);
}
