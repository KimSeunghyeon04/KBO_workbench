import * as React from "react";

export function OperationConsole({
  detail,
  master,
  onBack,
  selected,
}: {
  readonly detail: React.ReactNode;
  readonly master: React.ReactNode;
  readonly onBack: () => void;
  readonly selected: boolean;
}): React.JSX.Element {
  const masterRef = React.useRef<HTMLElement>(null);
  const detailRef = React.useRef<HTMLElement>(null);
  const backRef = React.useRef<HTMLButtonElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const compact = window.matchMedia("(max-width: 900px)");
    function restoreVisibleFocus() {
      if (!compact.matches) return;
      const focused = document.activeElement;
      if (selected && focused instanceof HTMLElement && masterRef.current?.contains(focused)) {
        returnFocus.current = focused;
        backRef.current?.focus();
      } else if (!selected && detailRef.current?.contains(focused)) {
        const previous = returnFocus.current;
        if (previous?.isConnected && masterRef.current?.contains(previous)) previous.focus();
        else masterRef.current?.focus();
      }
    }
    restoreVisibleFocus();
    compact.addEventListener("change", restoreVisibleFocus);
    return () => compact.removeEventListener("change", restoreVisibleFocus);
  }, [selected]);
  return (
    <div className={selected ? "operation-console has-selection" : "operation-console"}>
      <section ref={masterRef} tabIndex={-1} className="panel operation-console-master">
        {master}
      </section>
      <section ref={detailRef} className="panel operation-console-detail">
        <button ref={backRef} type="button" className="operation-mobile-back" onClick={onBack}>
          ← 목록으로
        </button>
        {detail}
      </section>
    </div>
  );
}

export function OperationEmptyDetail({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}): React.JSX.Element {
  return (
    <div className="operation-empty-detail">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
