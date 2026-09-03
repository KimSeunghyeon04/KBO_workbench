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
  return (
    <div className="workspace-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-label={`${tab.label} ${String(tab.count)}`}
          aria-selected={activeTab === tab.id}
          className={activeTab === tab.id ? "selected" : undefined}
          key={tab.id}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          <strong>{String(tab.count)}</strong>
        </button>
      ))}
    </div>
  );
}
