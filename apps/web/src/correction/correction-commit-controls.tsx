export function CorrectionCommitControls({
  dirty,
  promotionAvailable,
  blockingCount,
  busy,
  allowQuarantine,
  onAllowQuarantine,
  onCommit,
}: {
  readonly dirty: boolean;
  readonly promotionAvailable: boolean;
  readonly blockingCount: number;
  readonly busy: boolean;
  readonly allowQuarantine: boolean;
  readonly onAllowQuarantine: (allowed: boolean) => void;
  readonly onCommit: (allowQuarantine: boolean) => void;
}): React.JSX.Element {
  const canCommit = dirty || promotionAvailable;
  return (
    <div className="commit-form">
      {blockingCount > 0 ? (
        <label className="check-field">
          <input
            type="checkbox"
            checked={allowQuarantine}
            onChange={(event) => onAllowQuarantine(event.target.checked)}
          />
          해결되지 않은 문제를 확인했으며 검토 필요 상태로 저장합니다.
        </label>
      ) : null}
      <button
        type="button"
        className="primary-button"
        disabled={busy || !canCommit || (blockingCount > 0 && !allowQuarantine)}
        onClick={() => onCommit(allowQuarantine)}
      >
        {blockingCount > 0
          ? "격리 원장 저장"
          : promotionAvailable && !dirty
            ? "DB 적재 가능 상태로 전환"
            : "현재 원장 저장"}
      </button>
    </div>
  );
}
