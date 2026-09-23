export interface WorkspaceTab<TabId extends string> {
  readonly id: TabId;
  readonly label: string;
  readonly count: number;
}

export function WorkspaceTabs<TabId extends string>({
  activeTab,
  ariaLabel,
  idPrefix,
  onChange,
  tabs,
}: {
  readonly activeTab: TabId;
  readonly ariaLabel: string;
  readonly idPrefix: string;
  readonly onChange: (tab: TabId) => void;
  readonly tabs: readonly WorkspaceTab<TabId>[];
}): React.JSX.Element {
  const buttons = useRef(new Map<TabId, HTMLButtonElement>());
  return (
    <div className="workspace-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => (
        <button
          ref={(element) => {
            if (element) buttons.current.set(tab.id, element);
            else buttons.current.delete(tab.id);
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-label={`${tab.label} ${String(tab.count)}`}
          aria-selected={activeTab === tab.id}
          tabIndex={activeTab === tab.id ? 0 : -1}
          className={activeTab === tab.id ? "selected" : undefined}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const nextIndex =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : null;
            const next = nextIndex === null ? undefined : tabs[nextIndex];
            if (!next) return;
            event.preventDefault();
            buttons.current.get(next.id)?.focus();
            onChange(next.id);
          }}
        >
          <span>{tab.label}</span>
          <strong>{String(tab.count)}</strong>
        </button>
      ))}
    </div>
  );
}
import { useRef } from "react";
