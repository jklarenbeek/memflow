/**
 * StageInspector — Slide-out drawer showing stage I/O details
 *
 * Triggered when user clicks a stage node in MessageDAGMini.
 * Shows full module info, input/output data, duration, and config.
 */
import { useEffect, useRef } from "react";

export interface StageDetail {
  stageId: string;
  module: string;
  status: string;
  durationMs: number;
  error?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

interface Props {
  stage: StageDetail | null;
  onClose: () => void;
}

export function StageInspector({ stage, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (stage) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [stage, onClose]);

  if (!stage) return null;

  const statusIcon = stage.status === "complete" ? "✓" : stage.status === "error" ? "✗" : "⟳";
  const statusClass = stage.status === "complete" ? "ok" : stage.status === "error" ? "error" : "running";

  return (
    <div className="stage-inspector-overlay">
      <div className="stage-inspector" ref={drawerRef}>
        <div className="inspector-header">
          <div className="inspector-title">
            <span className={`inspector-status-icon ${statusClass}`}>{statusIcon}</span>
            <h3>{stage.module}</h3>
          </div>
          <button className="inspector-close" onClick={onClose}>×</button>
        </div>

        <div className="inspector-body">
          <div className="inspector-section">
            <h4>Stage Info</h4>
            <div className="inspector-grid">
              <span className="inspector-label">Stage ID</span>
              <span className="inspector-value">{stage.stageId}</span>
              <span className="inspector-label">Module</span>
              <span className="inspector-value">{stage.module}</span>
              <span className="inspector-label">Status</span>
              <span className={`inspector-value inspector-status ${statusClass}`}>{stage.status}</span>
              <span className="inspector-label">Duration</span>
              <span className="inspector-value">{(stage.durationMs / 1000).toFixed(2)}s</span>
            </div>
          </div>

          {stage.error && (
            <div className="inspector-section error">
              <h4>Error</h4>
              <pre className="inspector-error">{stage.error}</pre>
            </div>
          )}

          {stage.config && Object.keys(stage.config).length > 0 && (
            <div className="inspector-section">
              <h4>Configuration</h4>
              <pre className="inspector-json">{JSON.stringify(stage.config, null, 2)}</pre>
            </div>
          )}

          {stage.input && Object.keys(stage.input).length > 0 && (
            <div className="inspector-section">
              <h4>Input</h4>
              <pre className="inspector-json">{JSON.stringify(stage.input, null, 2)}</pre>
            </div>
          )}

          {stage.output && Object.keys(stage.output).length > 0 && (
            <div className="inspector-section">
              <h4>Output</h4>
              <pre className="inspector-json">{JSON.stringify(stage.output, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
