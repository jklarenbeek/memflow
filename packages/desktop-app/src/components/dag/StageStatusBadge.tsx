import './DAG.css';
/**
 * StageStatusBadge — Compact status indicator for workflow stages
 *
 * Used in both the DAG view and the stage inspector to show
 * the current execution status of a stage.
 */

interface Props {
  status: "pending" | "running" | "complete" | "error";
  size?: "sm" | "md";
  showLabel?: boolean;
}

const STATUS_MAP = {
  pending: { icon: "○", label: "Pending", className: "badge-pending" },
  running: { icon: "◉", label: "Running", className: "badge-running" },
  complete: { icon: "✓", label: "Complete", className: "badge-complete" },
  error: { icon: "✗", label: "Error", className: "badge-error" },
};

export function StageStatusBadge({ status, size = "sm", showLabel = false }: Props) {
  const config = STATUS_MAP[status] ?? STATUS_MAP.pending;

  return (
    <span className={`stage-status-badge ${config.className} size-${size}`}>
      <span className="badge-icon">{config.icon}</span>
      {showLabel && <span className="badge-label">{config.label}</span>}
    </span>
  );
}
