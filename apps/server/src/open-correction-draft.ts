import {
  RevisionConflictError,
  type GameRevisionStore,
  type StagingWorkspace,
} from "@kbo/persistence";

export type DraftRevisionStore = Pick<
  GameRevisionStore,
  "loadCorrectionDraft" | "withCurrentRevisionBase"
>;
export type DraftWorkspace = Pick<
  StagingWorkspace,
  "readCurrentDocumentSnapshot" | "prepareCorrectionDraft" | "collectionToken" | "withGameOperation"
>;

export async function openCorrectionDraft(
  workspace: DraftWorkspace,
  store: DraftRevisionStore,
  gameId: string,
  revision: number,
  mode: "resume" | "replace",
) {
  if (mode === "resume") {
    const current = await workspace.withGameOperation(gameId, () =>
      workspace.readCurrentDocumentSnapshot(gameId),
    );
    if (current !== null) return current;
  }
  const expectedToken = mode === "replace" ? await workspace.collectionToken(gameId) : undefined;
  const document = await store.loadCorrectionDraft(gameId, revision);
  const base = document.revisionBase;
  if (base.kind !== "sealed_revision" || base.revision !== revision)
    throw new RevisionConflictError("교정 초안의 DB 기준이 요청한 revision과 다릅니다.");
  const install = await workspace.prepareCorrectionDraft(document);
  return workspace.withGameOperation(gameId, () =>
    install({
      preserve: mode === "resume",
      ...(expectedToken === undefined ? {} : { expectedToken }),
      guard: (publish) => store.withCurrentRevisionBase(gameId, base, publish),
    }),
  );
}
