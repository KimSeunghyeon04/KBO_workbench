import { parentPort } from "node:worker_threads";
import { CorrectionCommandError, createRecordCorrectionProposalBuilder } from "@kbo/correction";
import { stagingDocumentHash } from "@kbo/game-core";
import { NaverSourceFormatError, NaverSourceEvidenceError } from "@kbo/collection";
import type { Computation, ComputationReply, ComputationRequest } from "./computation.js";
const { compute }: typeof import("./computation.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./computation.ts" : "./computation.js",
    import.meta.url,
  ).href
);

const port = parentPort;
if (port === null) throw new Error("Computation requires a parent port");
let pending: { id: number; input: Computation } | undefined;
// One owned document per worker bounds proposal compile reuse without retaining every season.
let proposal:
  { hash: string; build: ReturnType<typeof createRecordCorrectionProposalBuilder> } | undefined;
port.on("message", async ({ id, input, append, complete }: ComputationRequest) => {
  let reply: ComputationReply;
  try {
    if (append) {
      const previous = pending;
      if (
        previous?.id !== id ||
        previous.input.kind !== input.kind ||
        !("rows" in previous.input) ||
        !("rows" in input)
      )
        throw new Error("Invalid computation chunk");
      // These arrays belong to this worker. Append once per row instead of copying the prefix.
      const rows = previous.input.rows;
      if (!Array.isArray(rows)) throw new Error("Invalid computation rows");
      for (const row of input.rows) rows.push(row);
      input = { ...input, rows };
    }
    if (!complete) {
      pending = { id, input };
      return;
    }
    pending = undefined;
    if (input.kind === "proposal") {
      const hash = stagingDocumentHash(input.document);
      if (proposal?.hash !== hash)
        proposal = { hash, build: createRecordCorrectionProposalBuilder(input.document) };
      reply = {
        id,
        ok: true,
        result: { kind: "proposal", value: proposal.build(input.notice, input.binding) },
      };
    } else reply = { id, ok: true, result: await compute(input) };
  } catch (error: unknown) {
    reply = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Computation failed",
      errorKind:
        error instanceof CorrectionCommandError
          ? "command"
          : error instanceof NaverSourceEvidenceError
            ? "evidence"
            : error instanceof NaverSourceFormatError
              ? "source"
              : "internal",
    };
  }
  port.postMessage(reply);
});
