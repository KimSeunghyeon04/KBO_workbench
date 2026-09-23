import type { ReactNode } from "react";

/** Keep frequently changed inputs visible; scope and advanced inputs remain native controls. */
export function AnalysisFilterBar({
  label,
  summary,
  children,
  advanced,
}: {
  label: string;
  summary: string;
  children: ReactNode;
  advanced: ReactNode;
}) {
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
