/**
 * StageNode — Custom React Flow node for DAG visualization
 *
 * Renders a workflow stage as a styled card with:
 *  - Module icon + name
 *  - Status indicator (pending/running/complete/error)
 *  - Duration badge
 *  - Click-to-inspect interaction
 */
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";

export interface StageNodeData {
  stageId: string;
  module: string;
  status: "pending" | "running" | "complete" | "error";
  durationMs?: number;
  error?: string;
  preview?: string;
  isEntry?: boolean;
  isTerminal?: boolean;
  onSelect?: (stageId: string) => void;
  [key: string]: unknown;
}

const STATUS_CONFIG = {
  pending: { icon: "○", className: "stage-pending", label: "Pending" },
  running: { icon: "◉", className: "stage-running", label: "Running" },
  complete: { icon: "✓", className: "stage-complete", label: "Complete" },
  error: { icon: "✗", className: "stage-error", label: "Error" },
} as const;

interface StageNodeProps {
  data: StageNodeData;
  selected?: boolean;
}

function StageNodeInner({ data, selected }: StageNodeProps) {
  const status = STATUS_CONFIG[data.status] ?? STATUS_CONFIG.pending;
  const duration = data.durationMs != null
    ? data.durationMs < 1000
      ? `${data.durationMs}ms`
      : `${(data.durationMs / 1000).toFixed(1)}s`
    : null;

  return (
    <div
      className={`stage-node ${status.className} ${selected ? "selected" : ""} ${data.isEntry ? "entry" : ""}`}
      onClick={() => data.onSelect?.(data.stageId)}
    >
      <Handle type="target" position={Position.Top} className="stage-handle" />

      <div className="stage-node-header">
        <span className={`stage-status-icon ${status.className}`}>{status.icon}</span>
        <span className="stage-module-name">{data.module}</span>
      </div>

      <div className="stage-node-body">
        <span className="stage-id">{data.stageId}</span>
        {duration && <span className="stage-duration">{duration}</span>}
      </div>

      {data.preview && (
        <div className="stage-node-preview">{data.preview}</div>
      )}

      {data.error && (
        <div className="stage-node-error" title={data.error}>
          {data.error.slice(0, 50)}…
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="stage-handle" />
    </div>
  );
}

export const StageNode = memo(StageNodeInner);
