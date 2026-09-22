import { open } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalStringify } from "@kbo/contracts";
import { atomicWrite, isMissing } from "./workspace-files.js";
import {
  CoverageSeasonSchema,
  coverageHash,
  validCoverageSeason,
  type CoverageSeason,
} from "./analysis-coverage-summary.js";

const envelopeSchema = Type.Object(
  { hash: Type.String({ pattern: "^[a-f0-9]{64}$" }), payload: CoverageSeasonSchema },
  { additionalProperties: false },
);
const maxBytes = 16 * 1024 * 1024;

/** Disposable, source-addressed summaries. Sealed facts remain the only data authority. */
export class AnalysisCoverageWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}

  public async read(sourceKey: string): Promise<CoverageSeason | null> {
    try {
      const handle = await open(this.target(sourceKey), "r");
      let value: unknown;
      try {
        if ((await handle.stat()).size > maxBytes) return null;
        value = JSON.parse(await handle.readFile("utf8")) as unknown;
      } finally {
        await handle.close();
      }
      if (!Value.Check(envelopeSchema, value) || value.payload.sourceKey !== sourceKey) return null;
      try {
        return coverageHash(value.payload) === value.hash && validCoverageSeason(value.payload)
          ? value.payload
          : null;
      } catch {
        return null;
      }
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  public async write(payload: CoverageSeason, signal?: AbortSignal): Promise<void> {
    Value.Assert(CoverageSeasonSchema, payload);
    if (!validCoverageSeason(payload)) throw new Error("Invalid coverage summary");
    const content = canonicalStringify({ hash: coverageHash(payload), payload });
    if (Buffer.byteLength(content) > maxBytes)
      throw new Error("Coverage summary exceeds size limit");
    signal?.throwIfAborted();
    await this.assertWriter();
    signal?.throwIfAborted();
    await atomicWrite(this.target(payload.sourceKey), content);
  }

  private target(sourceKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(sourceKey)) throw new Error("Invalid coverage source key");
    return path.join(this.root, "analysis", "coverage", `${sourceKey}.json`);
  }
}
