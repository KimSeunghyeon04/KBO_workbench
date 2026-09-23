import { MAX_EVENT_DRAFTS, type AddEventDraft, type DraftValidation } from "./event-add-composer";
import { eventKindLabel } from "./event-presentation";
export function DrawerHeader({
  title,
  titleId,
  descriptionId,
  pending,
  onClose,
}: {
  readonly title: string;
  readonly titleId: string;
  readonly descriptionId: string;
  readonly pending: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <header className="correction-drawer-header">
      <div>
        <span>평면 중계 원장</span>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>구조화 입력은 서버 전체 compile 후 작업 사본에 반영됩니다.</p>
      </div>
      <button
        type="button"
        className="drawer-close-button"
        aria-label="닫기"
        disabled={pending}
        onClick={onClose}
      >
        ×
      </button>
    </header>
  );
}

export function AddEventQueue({
  drafts,
  validations,
  activeDraftId,
  announcement,
  pending,
  onSelect,
  onMove,
  onRemove,
}: {
  readonly drafts: readonly AddEventDraft[];
  readonly validations: readonly DraftValidation[];
  readonly activeDraftId: string;
  readonly announcement: string;
  readonly pending: boolean;
  readonly onSelect: (draftId: string) => void;
  readonly onMove: (draftId: string, direction: -1 | 1) => void;
  readonly onRemove: (draftId: string) => void;
}): React.JSX.Element {
  const validationById = new Map(
    validations.map((validation) => [validation.draft.draftId, validation] as const),
  );
  return (
    <section className="event-add-queue" aria-labelledby="event-add-queue-title">
      <header>
        <div>
          <strong id="event-add-queue-title">추가할 행</strong>
          <span>
            {String(drafts.length)} / {String(MAX_EVENT_DRAFTS)}
          </span>
        </div>
        <p aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      </header>
      <ol>
        {drafts.map((draft, index) => {
          const validation = validationById.get(draft.draftId);
          const active = draft.draftId === activeDraftId;
          return (
            <li key={draft.draftId} className={active ? "is-active" : undefined}>
              <button
                type="button"
                className="event-add-draft-select"
                aria-current={active ? "step" : undefined}
                onClick={() => onSelect(draft.draftId)}
              >
                <span>{String(index + 1)}</span>
                <span>
                  <strong>{eventKindLabel(draft.editor.form.kind)}</strong>
                  <small>{draft.editor.form.relayText.trim() || "중계 문구 미입력"}</small>
                </span>
                {validation?.error === null && validation.event !== null ? (
                  <em>준비됨</em>
                ) : (
                  <em className="has-error">확인 필요</em>
                )}
              </button>
              <div className="event-add-draft-actions">
                <button
                  type="button"
                  aria-label={`${String(index + 1)}번 행 위로 이동`}
                  disabled={pending || index === 0}
                  onClick={() => onMove(draft.draftId, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${String(index + 1)}번 행 아래로 이동`}
                  disabled={pending || index === drafts.length - 1}
                  onClick={() => onMove(draft.draftId, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`${String(index + 1)}번 행 삭제`}
                  disabled={pending || drafts.length === 1}
                  onClick={() => onRemove(draft.draftId)}
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
