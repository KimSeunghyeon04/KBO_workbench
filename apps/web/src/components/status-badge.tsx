interface StatusBadgeProps {
  readonly healthy: boolean;
  readonly healthyLabel?: string;
  readonly unhealthyLabel?: string;
}

export function StatusBadge({
  healthy,
  healthyLabel = "정상",
  unhealthyLabel = "확인 필요",
}: StatusBadgeProps): React.JSX.Element {
  return (
    <span className={healthy ? "status-badge healthy" : "status-badge unhealthy"}>
      <span aria-hidden="true" />
      {healthy ? healthyLabel : unhealthyLabel}
    </span>
  );
}
