/**
 * DAGControls — Toolbar for the WorkflowDAG view
 *
 * Provides controls for:
 *  - Running a workflow
 *  - Resetting execution state
 *  - Switching layout direction (TB/LR)
 *  - Fit view / zoom controls
 *  - Workflow selector
 */
import { useDAGStore } from "../../stores/dagStore";
import { StageStatusBadge } from "./StageStatusBadge";

interface Props {
  onRun: () => void;
  onReset: () => void;
  onFitView: () => void;
  onLoadWorkflow: () => void;
}

export function DAGControls({ onRun, onReset, onFitView, onLoadWorkflow }: Props) {
  const { workflow, executionState, layoutDirection, setLayoutDirection, totalDurationMs, stageStatuses } = useDAGStore();

  const completedCount = Array.from(stageStatuses.values()).filter((s) => s.status === "complete").length;
  const totalCount = stageStatuses.size;

  return (
    <div className="dag-controls">
      <div className="dag-controls-left">
        <button
          className="dag-ctrl-btn primary"
          onClick={onLoadWorkflow}
          title="Load workflow"
        >
          📂 Load
        </button>

        <button
          className="dag-ctrl-btn accent"
          onClick={onRun}
          disabled={!workflow || executionState === "running"}
          title="Execute workflow"
        >
          {executionState === "running" ? "⟳ Running…" : "▶ Run"}
        </button>

        <button
          className="dag-ctrl-btn"
          onClick={onReset}
          disabled={executionState === "idle" || executionState === "running"}
          title="Reset execution state"
        >
          ↺ Reset
        </button>
      </div>

      <div className="dag-controls-center">
        {workflow && (
          <div className="dag-workflow-info">
            <span className="dag-wf-name">{workflow.name}</span>
            <span className="dag-wf-version">v{workflow.version}</span>
            {executionState !== "idle" && (
              <span className="dag-wf-progress">
                <StageStatusBadge status={executionState === "running" ? "running" : executionState === "complete" ? "complete" : "error"} />
                <span className="dag-progress-text">{completedCount}/{totalCount}</span>
              </span>
            )}
            {totalDurationMs != null && (
              <span className="dag-wf-duration">{(totalDurationMs / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}
      </div>

      <div className="dag-controls-right">
        <button
          className="dag-ctrl-btn icon"
          onClick={() => setLayoutDirection(layoutDirection === "TB" ? "LR" : "TB")}
          title={`Layout: ${layoutDirection === "TB" ? "Top→Bottom" : "Left→Right"}`}
        >
          {layoutDirection === "TB" ? "⬇" : "➡"}
        </button>

        <button
          className="dag-ctrl-btn icon"
          onClick={onFitView}
          title="Fit view"
        >
          ⊞
        </button>
      </div>
    </div>
  );
}
