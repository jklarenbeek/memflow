/**
 * MessageDAGMini — Compact inline DAG visualization per assistant message
 *
 * Shows workflow stages as a horizontal flow:
 * - Gray = pending, Blue pulse = running, Green = complete, Red = error
 * - Collapses to summary after completion
 */
import { useState } from "react";
import type { StageStatus } from "../../stores/chatStore";

interface Props {
  stages: StageStatus[];
  currentStageId?: string;
  stageTrace?: { stageId: string; module: string; durationMs: number; status: string }[];
  collapsed?: boolean;
}

export function MessageDAGMini({ stages, currentStageId, stageTrace, collapsed: initialCollapsed }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed ?? false);

  const allComplete = stages.every((s) => s.status === "complete" || s.status === "error");
  const totalDuration = stageTrace?.reduce((sum, s) => sum + s.durationMs, 0) ?? 0;
  const hasError = stages.some((s) => s.status === "error");

  if (collapsed && allComplete) {
    return (
      <button className="dag-mini-collapsed" onClick={() => setCollapsed(false)}>
        <span className={`dag-summary-icon ${hasError ? "error" : "ok"}`}>
          {hasError ? "✗" : "✓"}
        </span>
        <span className="dag-summary-text">
          {stages.length} stages · {(totalDuration / 1000).toFixed(1)}s
        </span>
        <span className="dag-expand-hint">click to expand</span>
      </button>
    );
  }

  return (
    <div className="dag-mini">
      <div className="dag-mini-flow">
        {stages.map((stage, i) => (
          <div key={stage.id} className="dag-mini-node-wrapper">
            {i > 0 && <div className="dag-mini-edge" />}
            <div
              className={`dag-mini-node ${stage.status} ${stage.id === currentStageId ? "current" : ""}`}
              title={`${stage.module}: ${stage.status}${stage.durationMs ? ` (${(stage.durationMs / 1000).toFixed(1)}s)` : ""}${stage.error ? `\nError: ${stage.error}` : ""}`}
            >
              <span className="node-label">{stage.module.slice(0, 3)}</span>
              {stage.status === "complete" && stage.durationMs && (
                <span className="node-duration">{(stage.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {allComplete && (
        <button className="dag-collapse-btn" onClick={() => setCollapsed(true)}>
          Collapse
        </button>
      )}
    </div>
  );
}
