import type { StagingGameDocumentV2, StoredFinding } from "@kbo/contracts";
import type { ReplayResult } from "@kbo/game-core";
import type { RevisionProjectionComputation } from "@kbo/persistence";
import type { PreparedCorrectionSnapshot } from "./correction-snapshot.js";
import type { ComputationRunner } from "./computation-protocol.js";

export type {
  Computation,
  ComputationResult,
  ComputationReply,
  ComputationRequest,
  ComputationRunner,
} from "./computation-protocol.js";

/** The optional inline executor loads domain implementations only when actually used. */
export const inlineComputation: ComputationRunner = {
  async run(input) {
    const { compute }: typeof import("./computation-executor.js") = await import(
      new URL(
        import.meta.url.endsWith(".ts") ? "./computation-executor.ts" : "./computation-executor.js",
        import.meta.url,
      ).href
    );
    return compute(input);
  },
};

export async function compileDocument(
  runner: ComputationRunner,
  document: StagingGameDocumentV2,
): Promise<ReplayResult> {
  const result = await runner.run({ kind: "compile", document });
  if (result.kind !== "compile") throw new Error("Unexpected compiler result");
  return result.value;
}

export async function compileCorrectionDocument(
  runner: ComputationRunner,
  document: StagingGameDocumentV2,
  storedFindings: readonly StoredFinding[],
): Promise<{ replay: ReplayResult; prepared: PreparedCorrectionSnapshot }> {
  const result = await runner.run({ kind: "compile", document, storedFindings });
  if (result.kind !== "compile" || result.snapshot === undefined)
    throw new Error("Missing correction snapshot");
  return { replay: result.value, prepared: result.snapshot };
}

export function createRevisionProjectionComputation(
  runner: ComputationRunner,
): RevisionProjectionComputation {
  return {
    async project(document, replay, revision, version) {
      const result = await runner.run({ kind: "projection", document, replay, revision, version });
      if (result.kind !== "projection") throw new Error("Unexpected projection result");
      return result.value;
    },
    async hash(tables, version) {
      const result = await runner.run({ kind: "projection_hash", tables, version });
      if (result.kind !== "projection_hash") throw new Error("Unexpected projection hash result");
      return result.value;
    },
  };
}
