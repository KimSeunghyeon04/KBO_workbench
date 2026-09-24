import type { OriginalComparison } from "./original-comparison";

export function OriginalComparisonView({
  comparison,
}: {
  readonly comparison: OriginalComparison;
}): React.JSX.Element {
  return (
    <details className="original-comparison">
      <summary>최초 원장과 비교</summary>
      <div className="original-comparison-summary">
        <span>추가 {String(comparison.eventCounts.added)}</span>
        <span>삭제 {String(comparison.eventCounts.removed)}</span>
        <span>수정 {String(comparison.eventCounts.changed)}</span>
        <span>순서 {String(comparison.eventCounts.moved)}</span>
        <span>명단 {String(comparison.rosterChanges)}</span>
        <span>tracking {String(comparison.trackingChanges)}</span>
        <span>공식 기록 {String(comparison.officialRecordChanges)}</span>
      </div>
      <div className="original-comparison-list">
        {comparison.events.length === 0 ? (
          <p className="muted-text">최초 원장과 다른 이벤트가 없습니다.</p>
        ) : (
          comparison.events.map((difference) => (
            <article
              className={`original-difference ${difference.kind}`}
              key={`${difference.kind}:${difference.eventId}`}
            >
              <header>
                <strong>{differenceKindLabel(difference.kind)}</strong>
                <code>{difference.eventId}</code>
              </header>
              <div>
                <section>
                  <span>최초</span>
                  <small>{sequenceLabel(difference.originalSequence)}</small>
                  <strong>{difference.originalText ?? "없음"}</strong>
                  <small>{difference.originalSummary ?? ""}</small>
                </section>
                <section>
                  <span>현재</span>
                  <small>{sequenceLabel(difference.currentSequence)}</small>
                  <strong>{difference.currentText ?? "없음"}</strong>
                  <small>{difference.currentSummary ?? ""}</small>
                </section>
              </div>
            </article>
          ))
        )}
      </div>
    </details>
  );
}

function differenceKindLabel(kind: "added" | "removed" | "changed" | "moved"): string {
  return ({ added: "추가", removed: "삭제", changed: "수정", moved: "순서 변경" } as const)[kind];
}

function sequenceLabel(sequence: number | null): string {
  return sequence === null ? "행 없음" : `${String(sequence + 1)}행`;
}
