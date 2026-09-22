import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisModelJobSchema,
  AnalysisModelJobIdSchema,
  AnalysisModelPolicySchema,
  LegacyAnalysisModelJobSchema,
  LegacyAnalysisModelPolicySchema,
  canonicalStringify,
  type AnalysisModelJob,
} from "@kbo/contracts";
import { atomicWrite, isMissing, readDirectoryIfPresent } from "./workspace-files.js";
export class AnalysisModelJobWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  private target(file: string) {
    return path.join(this.root, "analysis", "jobs", file);
  }
  private async read<S extends TSchema>(file: string, schema: S): Promise<Static<S> | null> {
    try {
      return Value.Decode(schema, JSON.parse(await readFile(this.target(file), "utf8")));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  public async get(id: string) {
    Value.Decode(AnalysisModelJobIdSchema, id);
    const job = await this.read(
      `${id}.json`,
      Type.Union([AnalysisModelJobSchema, LegacyAnalysisModelJobSchema]),
    );
    if (job !== null && job.id !== id) throw new Error("Model job identity mismatch");
    // The original closed format could only represent 2025. Preserve its file until a job update.
    return job === null || "version" in job
      ? job
      : { ...job, version: 2 as const, applicationSeason: 2025 };
  }
  public async latest() {
    let latest: AnalysisModelJob | null = null;
    for (const entry of await readDirectoryIfPresent(this.target(""))) {
      const id = entry.name.replace(/\.json$/u, "");
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json") ||
        !Value.Check(AnalysisModelJobIdSchema, id)
      )
        continue;
      const job = await this.get(id);
      if (
        job !== null &&
        (latest === null ||
          job.createdAt > latest.createdAt ||
          (job.createdAt === latest.createdAt && job.id > latest.id))
      )
        latest = job;
    }
    return latest;
  }
  public async save(job: AnalysisModelJob) {
    const decoded = Value.Decode(AnalysisModelJobSchema, job);
    await this.assertWriter();
    await atomicWrite(this.target(`${decoded.id}.json`), canonicalStringify(decoded));
  }
  public async policy() {
    const policy = await this.read(
      "policy.json",
      Type.Union([AnalysisModelPolicySchema, LegacyAnalysisModelPolicySchema]),
    );
    return policy !== null && "version" in policy
      ? policy
      : {
          version: 2 as const,
          enabledSeasons: policy?.enabled === true ? [2025] : [],
        };
  }
  public async setPolicy(applicationSeason: number, enabled: boolean) {
    Value.Decode(Type.Integer({ minimum: 2023, maximum: 2025 }), applicationSeason);
    const current = await this.policy();
    const seasons = new Set(current.enabledSeasons);
    if (enabled) seasons.add(applicationSeason);
    else seasons.delete(applicationSeason);
    const policy = Value.Decode(AnalysisModelPolicySchema, {
      version: 2,
      enabledSeasons: [...seasons].sort((a, b) => a - b),
    });
    await this.assertWriter();
    await atomicWrite(this.target("policy.json"), canonicalStringify(policy));
    return policy;
  }
}
