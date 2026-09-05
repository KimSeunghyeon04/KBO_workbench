import { buildNaverPitchMetadataEnrichment, type RawGameBundle } from "@kbo/collection";
import { canonicalStringify, type StagingGameDocumentV2 } from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type ReplayResult,
} from "@kbo/game-core";
import { type GameRevisionStore, type StagingWorkspace } from "@kbo/persistence";

import { mergePersistentSourceFindings } from "../correction-session-manager.js";
import { storedSourceFinding } from "../source-projection.js";

export function pitchMetadataCoverage(document: StagingGameDocumentV2) {
  const pitches = document.events.filter((event) => event.kind === "pitch");
  const speed = pitches.filter((event) => event.payload.speedKph !== undefined).length;
  const type = pitches.filter((event) => event.payload.pitchType !== undefined).length;
  return {
    pitches: pitches.length,
    speed,
    type,
    speedRate: pitches.length === 0 ? null : speed / pitches.length,
    typeRate: pitches.length === 0 ? null : type / pitches.length,
  };
}

export function preparePitchMetadataEnrichment(
  document: StagingGameDocumentV2,
  bundle: RawGameBundle,
) {
  const enrichment = buildNaverPitchMetadataEnrichment(document, bundle);
  let corrected = document;
  for (let offset = 0; offset < enrichment.replacements.length; offset += 100) {
    corrected = applyCorrectionCommand(corrected, {
      kind: "correction_batch",
      commandId: `pitch-metadata-${String(offset)}`,
      commands: enrichment.replacements.slice(offset, offset + 100).map((event, index) => ({
        kind: "replace_event",
        commandId: `pitch-metadata-${String(offset + index)}-replace`,
        eventId: event.identity.eventId,
        event,
      })),
    }).document;
  }
  const replay = compileStagingGameDocumentV2(corrected);
  if (
    canonicalStringify(withoutMetadata(document)) !==
      canonicalStringify(withoutMetadata(corrected)) ||
    canonicalStringify(withoutFactMetadata(compileStagingGameDocumentV2(document))) !==
      canonicalStringify(withoutFactMetadata(replay))
  ) {
    throw new Error("구속·구종 이외의 원장 또는 경기 계산 결과가 변경되어 보완을 거부했습니다.");
  }
  return { document: corrected, replay, enrichment };
}

/** One game owns one commit; a workspace draft always takes precedence over its DB base. */
export async function enrichPitchMetadataGame(
  workspace: StagingWorkspace,
  store: Pick<GameRevisionStore, "loadCorrectionDraft" | "importRevision" | "currentRevisionBase">,
  gameId: string,
  apply: boolean,
) {
  const snapshot = await workspace.readCurrentDocumentSnapshot(gameId);
  const base = snapshot === null ? await store.currentRevisionBase(gameId) : null;
  if (snapshot === null && base === null) throw new Error("현재 원장 또는 DB revision이 없습니다.");
  const document =
    snapshot !== null
      ? snapshot.document
      : base !== null
        ? await store.loadCorrectionDraft(gameId, base.revision)
        : null;
  if (document === null) throw new Error("현재 원장을 읽을 수 없습니다.");
  const source = await workspace.readSourceBundle(
    document.metadata.season,
    gameId,
    document.source.sourceBundleHash,
  );
  const prepared = preparePitchMetadataEnrichment(document, source);
  const before = pitchMetadataCoverage(document);
  const after = pitchMetadataCoverage(prepared.document);
  const changedPitches = prepared.enrichment.replacements.length;
  let revision: number | null = null;
  if (apply && changedPitches > 0) {
    if (snapshot !== null) {
      const findings = mergePersistentSourceFindings(
        [...snapshot.findings, ...prepared.enrichment.findings.map(storedSourceFinding)],
        prepared.replay.findings,
        prepared.document,
      );
      await workspace.commitCorrection({
        baseAuthority: snapshot.authority,
        targetAuthority: findings.some((finding) => finding.severity === "blocking")
          ? "quarantine"
          : "staging",
        baseDocumentHash: stagingDocumentHash(document),
        document: prepared.document,
        findingEnvelope: { schemaVersion: 2, findings },
      });
    } else {
      revision = (await store.importRevision(prepared.document)).revision;
    }
  }
  return {
    gameId,
    season: document.metadata.season,
    authority: snapshot?.authority ?? "database",
    status: changedPitches === 0 ? "unchanged" : apply ? "applied" : "proposed",
    changedPitches,
    before,
    after,
    revision,
    sourceBundleHash: document.source.sourceBundleHash,
    issues: prepared.enrichment.issues,
    warnings: prepared.enrichment.findings,
  };
}

function withoutMetadata(document: StagingGameDocumentV2) {
  return {
    ...document,
    events: document.events.map((event) => {
      if (event.kind !== "pitch") return event;
      const payload = { ...event.payload };
      delete payload.speedKph;
      delete payload.pitchType;
      return { ...event, payload };
    }),
  };
}

function withoutFactMetadata(replay: ReplayResult) {
  return {
    ...replay,
    pitchFacts: replay.pitchFacts.map((fact) => {
      const rest = { ...fact };
      delete rest.speedKph;
      delete rest.pitchType;
      return rest;
    }),
  };
}
