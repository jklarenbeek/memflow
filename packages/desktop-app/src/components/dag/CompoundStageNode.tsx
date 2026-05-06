import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { useDAGStore, DAGStageStatus } from "../../stores/dagStore";
import "./DAG.css";

interface CompoundStageData extends Record<string, unknown> {
  label: string;
  module: string;
  status: DAGStageStatus;
  processId: string;
  stageId: string;
  isExpanded: boolean;
  childStageCount: number;
}

interface CompoundStageNodeProps {
  data: CompoundStageData;
  isConnectable?: boolean;
}

const STATUS_CONFIG = {
  pending: { icon: "○", className: "stage-pending", label: "Pending" },
  running: { icon: "◉", className: "stage-running", label: "Running" },
  complete: { icon: "✓", className: "stage-complete", label: "Complete" },
  error: { icon: "✗", className: "stage-error", label: "Error" },
} as const;

/**
 * Renders a sub-workflow stage.
 * When collapsed, shows a toggle and stage count badge.
 * When expanded, renders as a container with children laid out inside.
 */
export const CompoundStageNode = memo(({ data, isConnectable }: CompoundStageNodeProps) => {
  const toggleStageExpansion = useDAGStore((s) => s.toggleStageExpansion);
  const status = STATUS_CONFIG[data.status.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.pending;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleStageExpansion(data.processId, data.stageId);
  };

  return (
    <div 
      className={`compound-stage-node ${data.isExpanded ? "expanded" : ""}`}
      style={{ 
        borderColor: data.status.status === "running" ? "var(--accent)" 
                   : data.status.status === "complete" ? "var(--success)" 
                   : data.status.status === "error" ? "var(--error)" 
                   : "var(--border)"
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={isConnectable} />
      
      <div className="compound-stage-header" onClick={handleToggle}>
        <span className={`compound-stage-toggle ${data.isExpanded ? "expanded" : ""}`}>
          ▸
        </span>
        <span className={`stage-status-icon ${status.className}`}>{status.icon}</span>
        <span className="stage-module-name">{data.module}</span>
        
        {!data.isExpanded && data.childStageCount > 0 && (
          <span className="compound-stage-badge">{data.childStageCount} stages</span>
        )}
      </div>

      {data.isExpanded && (
        <div className="compound-stage-children">
          {/* React Flow renders child nodes here automatically based on parentNode property */}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} />
    </div>
  );
});

CompoundStageNode.displayName = "CompoundStageNode";
