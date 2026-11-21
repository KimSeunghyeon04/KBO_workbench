import { useEffect, useRef, useState } from "react";
import {
  MAX_BULK_CORRECTION_EVENTS,
  type CorrectionCommand,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { newCommandId } from "./event-editor-registry";

export function BulkEventActions({
  events,
  selectedIds,
  visibleIds,
  sessionKey,
  pending,
  onApply,
  onClear,
  onSelectAll,
}: {
  readonly events: readonly StagingRelayEvent[];
  readonly selectedIds: ReadonlySet<string>;
  readonly visibleIds: ReadonlySet<string>;
  readonly sessionKey: string;
  readonly pending: boolean;
  readonly onApply: (command: CorrectionCommand) => void;
  readonly onClear: () => void;
  readonly onSelectAll: () => void;
}): React.JSX.Element {
  const selected = events.filter((event) => selectedIds.has(event.identity.eventId));
  const ids = selected.map((event) => event.identity.eventId);
  const binding = `${sessionKey}:${JSON.stringify(ids)}`;
  const [action, setAction] = useState<{ binding: string; kind: "delete" | "move" } | null>(null);
  const [position, setPosition] = useState("");
  const positionRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const moveTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const mode = action?.binding === binding ? action.kind : null;
  const hidden = selected.filter((event) => !visibleIds.has(event.identity.eventId)).length;
  const disabled = pending || ids.length === 0 || ids.length > MAX_BULK_CORRECTION_EVENTS;
  useEffect(() => {
    if (mode === "move") positionRef.current?.focus();
    if (mode === "delete") cancelRef.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (action !== null && action.binding !== binding) {
      setAction(null);
      if (document.activeElement === document.body)
        (action.kind === "move" ? moveTrigger : deleteTrigger).current?.focus();
    }
  }, [action, binding]);
  const cancel = (): void => {
    setAction(null);
    (mode === "move" ? moveTrigger : deleteTrigger).current?.focus();
  };
  const number = Number(position);
  const target = events[number - 1];
  const validPosition =
    /^\d+$/.test(position) &&
    Number.isSafeInteger(number) &&
    number >= 1 &&
    number <= events.length + 1;
  const selectedTarget = target !== undefined && selectedIds.has(target.identity.eventId);
  const beforeEventId = target?.identity.eventId ?? null;
  const remaining = events.filter((event) => !selectedIds.has(event.identity.eventId));
  const insertion =
    beforeEventId === null
      ? remaining.length
      : remaining.findIndex((event) => event.identity.eventId === beforeEventId);
  const proposed = [...remaining.slice(0, insertion), ...selected, ...remaining.slice(insertion)];
  const unchanged = proposed.every(
    (event, index) => event.identity.eventId === events[index]?.identity.eventId,
  );
  return (
    <section
      className="event-selection-actions"
      aria-label="선택한 행 작업"
      onKeyDown={(event) => {
        if (event.key === "Escape" && mode !== null && !pending) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="event-selection-summary" role="status" aria-live="polite">
        <strong>{ids.length}행 선택</strong>
        {hidden > 0 ? <span>숨겨진 {hidden}행 포함</span> : null}
      </div>
      <div className="event-selection-buttons">
        <button
          type="button"
          disabled={pending || ids.length === events.length}
          onClick={onSelectAll}
        >
          전체 선택
        </button>
        <button type="button" disabled={pending || ids.length === 0} onClick={onClear}>
          선택 해제
        </button>
        <button
          type="button"
          ref={moveTrigger}
          disabled={disabled || ids.length === events.length}
          onClick={() => {
            setPosition("");
            setAction({ binding, kind: "move" });
          }}
        >
          선택 행 이동
        </button>
        <button
          type="button"
          ref={deleteTrigger}
          className="danger"
          disabled={disabled}
          onClick={() => setAction({ binding, kind: "delete" })}
        >
          선택 행 삭제
        </button>
      </div>
      {ids.length > MAX_BULK_CORRECTION_EVENTS ? (
        <p className="inline-error">
          한 번에 {MAX_BULK_CORRECTION_EVENTS.toLocaleString()}행까지 처리할 수 있습니다. 선택
          범위를 줄여 주세요.
        </p>
      ) : null}
      {mode === "delete" ? (
        <div className="event-selection-confirm" role="group" aria-label="선택 행 삭제 확인">
          <p>
            <strong>{ids.length}행을 삭제할까요?</strong>
            {hidden > 0 ? ` 접기·필터로 숨겨진 ${hidden}행도 포함됩니다.` : ""} 한 번의 실행 취소로
            복구할 수 있습니다.
          </p>
          <button type="button" ref={cancelRef} disabled={pending} onClick={cancel}>
            취소
          </button>
          <button
            type="button"
            className="danger"
            disabled={disabled}
            onClick={() =>
              onApply({ commandId: newCommandId(), kind: "delete_events", eventIds: ids })
            }
          >
            {ids.length}행 삭제
          </button>
        </div>
      ) : null}
      {mode === "move" ? (
        <form
          className="event-selection-move"
          aria-label="선택 행 이동"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !validPosition || selectedTarget || unchanged) return;
            onApply({
              commandId: newCommandId(),
              kind: "move_events",
              eventIds: ids,
              beforeEventId,
            });
          }}
        >
          <label>
            이 행 앞으로 이동
            <input
              ref={positionRef}
              type="number"
              min={1}
              max={events.length + 1}
              value={position}
              disabled={pending}
              onChange={(event) => setPosition(event.target.value)}
              aria-describedby="bulk-move-target-description"
            />
          </label>
          <p id="bulk-move-target-description">
            원장 행 번호 1–{events.length}을 입력하세요. {events.length + 1}은 원장 맨 뒤입니다.
            선택한 행은 원래 순서대로 함께 이동합니다.
          </p>
          {position !== "" ? (
            <p className={validPosition && !selectedTarget ? "muted-text" : "inline-error"}>
              {!validPosition
                ? "이동할 행 번호를 확인해 주세요."
                : selectedTarget
                  ? "이동 기준 행은 선택 범위 밖이어야 합니다."
                  : unchanged
                    ? "현재 위치와 같습니다."
                    : target
                      ? `#${number} · ${target.relayText ?? target.kind} 앞으로 이동합니다.`
                      : "원장 맨 뒤로 이동합니다."}
            </p>
          ) : null}
          <div className="event-selection-buttons">
            <button type="button" disabled={pending} onClick={cancel}>
              취소
            </button>
            <button
              type="submit"
              disabled={disabled || !validPosition || selectedTarget || unchanged}
            >
              이동 적용
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
