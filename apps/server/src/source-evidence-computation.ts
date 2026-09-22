import { extractNaverSourceEvidence } from "@kbo/collection";
import {
  canonicalStringify,
  type CorrectionSourceEvidence,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { readImmutableSourceBundle, type ImmutableSourceBundle } from "@kbo/persistence";
const { BoundedReadCache }: typeof import("./bounded-read-cache.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./bounded-read-cache.ts" : "./bounded-read-cache.js",
    import.meta.url,
  ).href
);

export interface SourceEvidenceComputationInput {
  root: string;
  season: number;
  gameId: string;
  hash: string;
  event: StagingRelayEvent;
}

/** Each of the two shared workers retains at most half of the source cache budget. */
export class SourceEvidenceComputer {
  private readonly sources = new BoundedReadCache<ImmutableSourceBundle>(
    16 * 1024 * 1024,
    4,
    300_000,
  );
  private readonly read: typeof readImmutableSourceBundle;
  public constructor(read = readImmutableSourceBundle) {
    this.read = read;
  }

  public async run(input: SourceEvidenceComputationInput): Promise<CorrectionSourceEvidence> {
    const key = canonicalStringify([input.root, input.season, input.gameId, input.hash]);
    const bundle = await this.sources.load(key, () =>
      this.read(input.root, input.season, input.gameId, input.hash),
    );
    return extractNaverSourceEvidence({ event: input.event, payloads: bundle.payloads });
  }
}
