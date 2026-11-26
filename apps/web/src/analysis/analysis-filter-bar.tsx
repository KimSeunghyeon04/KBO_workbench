import type { ReactNode } from "react";

/** Player reports may fold secondary filters while keeping the applied scope visible. */
export function AnalysisFilterBar({
  label,
  summary,
  children,
  advanced,
  collapsible = false,
  toggleLabel = "조회 조건 변경",
}: {
  label: string;
  summary: string;
  children?: ReactNode;
  advanced: ReactNode;
  collapsible?: boolean;
  toggleLabel?: string;
}) {
  if (collapsible)
    return (
      <details className="panel analysis-filter-bar analysis-report-filters" aria-label={label}>
        <summary>
          <strong>{toggleLabel}</strong>
          <span>{summary}</span>
        </summary>
        {children != null && <div className="analysis-primary-filters">{children}</div>}
        <div className="analysis-filter-fields">{advanced}</div>
      </details>
    );
  return (
    <section className="panel analysis-filter-bar" aria-label={label}>
      <div className="analysis-primary-filters">{children}</div>
      <details className="analysis-advanced-filters">
        <summary>
          <strong>세부 조건</strong>
          <span>{summary}</span>
        </summary>
        <div className="analysis-filter-fields">{advanced}</div>
      </details>
    </section>
  );
}
