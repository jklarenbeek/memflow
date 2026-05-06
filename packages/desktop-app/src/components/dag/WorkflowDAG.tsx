import './DAG.css';
/**
 * WorkflowDAG — Interactive workflow DAG visualizer
 *
 * Renders the workflow stages as a directed acyclic graph using React Flow.
 * Features:
 *  - Auto-layout with dagre (TB/LR direction)
 *  - Virtual Start / End label nodes for workflow boundaries
 *  - Real-time status updates via SSE during execution
 *  - Click-to-inspect stage details
 *  - Workflow loading from the catalog
 *  - Run workflow with streaming progress
 *  - Multi-process selector bar for concurrent ingestion pipelines
 */
import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { StageNode, type StageNodeData } from "./StageNode";
import { CompoundStageNode } from "./CompoundStageNode";
import { DAGControls } from "./DAGControls";
import { StageStatusBadge } from "./StageStatusBadge";
import { useDAGStore, type DAGWorkflow } from "../../stores/dagStore";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

// ---------------------------------------------------------------------------
// Node types registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes = { stage: StageNode, compound: CompoundStageNode } as any;

// ---------------------------------------------------------------------------
// Layout helper (simplified dagre-like layout without external dep)
// ---------------------------------------------------------------------------

/** Identifies terminal stages (no outgoing edges) */
function findTerminalStages(workflow: DAGWorkflow): Set<string> {
  const terminals = new Set<string>();
  for (const stage of workflow.stages) {
    const hasNext =
      (typeof stage.next === "string" && stage.next.length > 0) ||
      (Array.isArray(stage.next) && stage.next.length > 0) ||
      (stage.next && typeof stage.next === "object" && !Array.isArray(stage.next) && Object.keys(stage.next).length > 0);
    if (!hasNext) terminals.add(stage.id);
  }
  return terminals;
}

function layoutWorkflow(
  workflow: DAGWorkflow,
  direction: "TB" | "LR",
  executionState: "idle" | "running" | "complete" | "error",
  expandedStages: Set<string>,
  activeProcessId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const nodeWidth = 180;
  const nodeHeight = 90;
  const hGap = 60;
  const vGap = 80;

  // Build adjacency for topological sort
  const stageMap = new Map(workflow.stages.map((s) => [s.id, s]));
  const incoming = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const stage of workflow.stages) {
    incoming.set(stage.id, 0);
    adjacency.set(stage.id, []);
  }

  const edges: Edge[] = [];
  for (const stage of workflow.stages) {
    const nexts: string[] = [];
    if (typeof stage.next === "string") {
      nexts.push(stage.next);
    } else if (Array.isArray(stage.next)) {
      nexts.push(...stage.next);
    } else if (stage.next && typeof stage.next === "object") {
      nexts.push(...Object.values(stage.next));
    }

    for (const n of nexts) {
      adjacency.get(stage.id)?.push(n);
      incoming.set(n, (incoming.get(n) ?? 0) + 1);
      edges.push({
        id: `${stage.id}-${n}`,
        source: stage.id,
        target: n,
        type: "smoothstep",
        animated: false,
        style: { stroke: "var(--border)", strokeWidth: 2 },
      });
    }
  }

  // Topological sort (BFS / Kahn's algorithm)
  const queue: string[] = [];
  for (const [id, count] of incoming) {
    if (count === 0) queue.push(id);
  }

  const layers: string[][] = [];
  while (queue.length > 0) {
    const layer = [...queue];
    layers.push(layer);
    queue.length = 0;

    for (const id of layer) {
      for (const next of adjacency.get(id) ?? []) {
        const newCount = (incoming.get(next) ?? 1) - 1;
        incoming.set(next, newCount);
        if (newCount === 0) queue.push(next);
      }
    }
  }

  // Position nodes in layers
  const nodes: Node[] = [];
  const terminalStages = findTerminalStages(workflow);

  // ---------------------------------------------------------------------------
  // Virtual "Start" node — placed before the first layer
  // ---------------------------------------------------------------------------
  const startNodeId = "__start__";
  const startX = direction === "TB" ? 0 : -(nodeWidth + hGap);
  const startY = direction === "TB" ? -(nodeHeight + vGap) : 0;

  nodes.push({
    id: startNodeId,
    type: "default",
    position: { x: startX - nodeWidth / 2, y: startY },
    data: { label: "▶ Start" },
    style: {
      background: "var(--accent)",
      color: "white",
      border: "2px solid var(--accent)",
      borderRadius: "24px",
      padding: "8px 20px",
      fontWeight: 700,
      fontSize: "13px",
      minWidth: "100px",
      textAlign: "center" as const,
      fontFamily: "var(--font-sans)",
    },
    selectable: false,
    draggable: false,
  });

  // Edge from Start to entry stage
  edges.push({
    id: `${startNodeId}-${workflow.entry}`,
    source: startNodeId,
    target: workflow.entry,
    type: "smoothstep",
    animated: false,
    style: { stroke: "var(--accent)", strokeWidth: 2, strokeDasharray: "6 3" },
  });

  // ---------------------------------------------------------------------------
  // Stage nodes — positioned in topological layers
  // ---------------------------------------------------------------------------
  let currentY = direction === "TB" ? 0 : 0;
  let currentX = direction === "LR" ? 0 : 0;

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    
    // Calculate dimensions
    const nodeDims = layer.map(stageId => {
      const stage = stageMap.get(stageId);
      const isCompound = !!stage?.workflowRef || !!stage?.childWorkflow;
      const isExpanded = isCompound && expandedStages.has(`${activeProcessId ?? "null"}:${stageId}`);
      let w = nodeWidth;
      let h = nodeHeight;
      if (isExpanded && stage?.childWorkflow) {
        const childCount = stage.childWorkflow.stages.length;
        if (direction === "TB") {
          w = nodeWidth + 60;
          h = childCount * (nodeHeight + 30) + 60;
        } else {
          w = childCount * (nodeWidth + 30) + 60;
          h = nodeHeight + 80;
        }
      }
      return { stageId, stage, isCompound, isExpanded, w, h };
    });

    const maxH = Math.max(...nodeDims.map(d => d.h));
    const maxW = Math.max(...nodeDims.map(d => d.w));

    const layerWidth = nodeDims.reduce((sum, d) => sum + d.w, 0) + (layer.length - 1) * hGap;
    let layerX = -layerWidth / 2;
    let layerY = -layerWidth / 2;

    for (const d of nodeDims) {
      if (!d.stage) continue;

      const x = direction === "TB" ? layerX : currentX;
      const y = direction === "TB" ? currentY : layerY;

      if (direction === "TB") layerX += d.w + hGap;
      else layerY += d.w + hGap;

      const baseNode = {
        id: d.stageId,
        position: { x, y },
        data: {
          stageId: d.stageId,
          module: d.stage.module,
          status: "pending",
          isEntry: d.stageId === workflow.entry,
          isTerminal: terminalStages.has(d.stageId),
        },
      };

      if (d.isCompound) {
        nodes.push({
          ...baseNode,
          type: "compound",
          style: d.isExpanded ? { width: d.w, height: d.h, zIndex: -1 } : undefined,
          data: {
            ...baseNode.data,
            label: d.stage.module,
            isExpanded: d.isExpanded,
            processId: activeProcessId ?? "null",
            childStageCount: d.stage.childWorkflow?.stages.length ?? 0,
          },
        });

        if (d.isExpanded && d.stage.childWorkflow) {
          // Add child nodes
          let childY = 40; // below header
          let childX = 30;
          for (let i = 0; i < d.stage.childWorkflow.stages.length; i++) {
            const childStage = d.stage.childWorkflow.stages[i];
            const childId = `${d.stageId}.${childStage.id}`;
            nodes.push({
              id: childId,
              type: "stage",
              parentId: d.stageId,
              position: { x: childX, y: childY },
              style: { zIndex: 10 },
              data: {
                stageId: childId,
                module: childStage.module,
                status: "pending",
                isEntry: i === 0,
                isTerminal: i === d.stage.childWorkflow.stages.length - 1,
              },
            });

            // Edge to next child
            if (i < d.stage.childWorkflow.stages.length - 1) {
              const nextChildId = `${d.stageId}.${d.stage.childWorkflow.stages[i+1].id}`;
              edges.push({
                id: `${childId}-${nextChildId}`,
                source: childId,
                target: nextChildId,
                type: "smoothstep",
                animated: false,
                style: { stroke: "var(--border)", strokeWidth: 2 },
              });
            }

            if (direction === "TB") childY += nodeHeight + 30;
            else childX += nodeWidth + 30;
          }
        }
      } else {
        nodes.push({ ...baseNode, type: "stage" });
      }
    }

    if (direction === "TB") currentY += maxH + vGap;
    else currentX += maxW + hGap;
  }

  // ---------------------------------------------------------------------------
  // Virtual "End" node — placed after the last layer
  // ---------------------------------------------------------------------------
  const endNodeId = "__end__";
  const endX = direction === "TB" ? 0 : currentX;
  const endY = direction === "TB" ? currentY : 0;
  const isCompleted = executionState === "complete";

  nodes.push({
    id: endNodeId,
    type: "default",
    position: { x: endX - nodeWidth / 2, y: endY },
    data: { label: isCompleted ? "✓ End" : "◻ End" } as unknown as StageNodeData,
    style: {
      background: isCompleted ? "var(--success)" : "var(--bg-tertiary)",
      color: isCompleted ? "white" : "var(--text-muted)",
      border: `2px solid ${isCompleted ? "var(--success)" : "var(--border)"}`,
      borderRadius: "24px",
      padding: "8px 20px",
      fontWeight: 700,
      fontSize: "13px",
      minWidth: "100px",
      textAlign: "center" as const,
      fontFamily: "var(--font-sans)",
      boxShadow: isCompleted ? "0 0 16px rgba(52, 211, 153, 0.3)" : "none",
      transition: "all 0.3s ease",
    },
    selectable: false,
    draggable: false,
  });

  // Edges from terminal stages to End
  for (const termId of terminalStages) {
    edges.push({
      id: `${termId}-${endNodeId}`,
      source: termId,
      target: endNodeId,
      type: "smoothstep",
      animated: false,
      style: {
        stroke: isCompleted ? "var(--success)" : "var(--border)",
        strokeWidth: 2,
        strokeDasharray: "6 3",
      },
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Process status icon map
// ---------------------------------------------------------------------------
const PROCESS_STATUS_ICONS: Record<string, string> = {
  running: "◉",
  complete: "✓",
  error: "✗",
};

// ---------------------------------------------------------------------------
// WorkflowDAG Component
// ---------------------------------------------------------------------------

export function WorkflowDAG() {
  const {
    workflow, stageStatuses, executionState, selectedStageId, layoutDirection,
    trackedProcesses,    activeProcessId, expandedStages
  } = useDAGStore();
  const {
    loadWorkflow, setStageStatus, setExecutionState, setSelectedStage,
    setWorkflowId, setTotalDuration, resetExecution, setActiveProcess,
  } = useDAGStore();
  const serverUrl = useAppStore((s) => s.serverUrl);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [workflows, setWorkflows] = useState<Array<{ name: string; version: string; description?: string; stages: unknown[] }>>([]);
  const reactFlowInstance = useReactFlow();

  // Layout nodes when workflow, direction, or executionState changes
  useEffect(() => {
    if (!workflow) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const layout = layoutWorkflow(workflow, layoutDirection, executionState, expandedStages, activeProcessId);
    setNodes(layout.nodes);
    setEdges(layout.edges);
    // Fit view after layout
    setTimeout(() => reactFlowInstance.fitView({ padding: 0.2 }), 50);
  }, [workflow, layoutDirection, executionState, expandedStages, activeProcessId, setNodes, setEdges, reactFlowInstance]);

  // Update node data when stage statuses change
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        // Skip virtual Start/End nodes
        if (node.id === "__start__" || node.id === "__end__") return node;

        const status = stageStatuses.get(node.id);
        if (!status) return node;
        return {
          ...node,
          data: {
            ...node.data,
            status: status.status,
            durationMs: status.durationMs,
            error: status.error,
            preview: status.preview,
            onSelect: (id: string) => setSelectedStage(id),
          },
        };
      }),
    );
  }, [stageStatuses, setNodes, setSelectedStage]);

  // Animate edges based on status
  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        // Skip edges from/to virtual nodes (Start → entry, terminal → End)
        if (edge.source === "__start__") {
          return {
            ...edge,
            style: { ...edge.style, stroke: "var(--accent)", strokeDasharray: "6 3" },
          };
        }
        if (edge.target === "__end__") {
          const sourceStatus = stageStatuses.get(edge.source);
          const isSourceComplete = sourceStatus?.status === "complete";
          return {
            ...edge,
            style: {
              ...edge.style,
              stroke: isSourceComplete ? "var(--success)" : "var(--border)",
              strokeDasharray: "6 3",
            },
          };
        }

        const sourceStatus = stageStatuses.get(edge.source);
        const isRunning = sourceStatus?.status === "running";
        const isComplete = sourceStatus?.status === "complete";
        return {
          ...edge,
          animated: isRunning,
          style: {
            ...edge.style,
            stroke: isComplete ? "var(--success)" : isRunning ? "var(--info)" : "var(--border)",
            strokeDasharray: undefined,
          },
        };
      }),
    );
  }, [stageStatuses, setEdges]);

  // Update End node styling when executionState changes
  useEffect(() => {
    const isCompleted = executionState === "complete";
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id !== "__end__") return node;
        return {
          ...node,
          data: { label: isCompleted ? "✓ End" : "◻ End" },
          style: {
            ...node.style,
            background: isCompleted ? "var(--success)" : "var(--bg-tertiary)",
            color: isCompleted ? "white" : "var(--text-muted)",
            border: `2px solid ${isCompleted ? "var(--success)" : "var(--border)"}`,
            boxShadow: isCompleted ? "0 0 16px rgba(52, 211, 153, 0.3)" : "none",
          },
        };
      }),
    );
  }, [executionState, setNodes]);

  // Load workflow catalog
  const handleLoadWorkflow = useCallback(async () => {
    try {
      const result = await api.listWorkflows();
      setWorkflows(result.workflows as typeof workflows);
      setCatalogOpen(true);
    } catch (err) {
      console.error("Failed to load workflows:", err);
    }
  }, []);

  // Select a workflow from catalog
  const handleSelectWorkflow = useCallback(
    async (name: string) => {
      try {
        const result = await api.getWorkflow(name);
        loadWorkflow(result.workflow as unknown as DAGWorkflow);
        setCatalogOpen(false);
      } catch (err) {
        console.error("Failed to load workflow:", err);
      }
    },
    [loadWorkflow],
  );

  // Run workflow via SSE streaming
  const handleRun = useCallback(async () => {
    if (!workflow) return;

    setExecutionState("running");
    resetExecution();
    setExecutionState("running");

    try {
      const response = await fetch(`${serverUrl}/workflow/run/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          input: {},
        }),
      });

      if (!response.ok || !response.body) {
        setExecutionState("error");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentData = "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            currentData = line.slice(5).trim();
          } else if (line.trim() === "" && currentData) {
            try {
              const event = JSON.parse(currentData) as Record<string, unknown>;
              handleSSEEvent(event);
            } catch { /* skip malformed */ }
            currentData = "";
          }
        }
      }
    } catch (err) {
      console.error("SSE stream error:", err);
      setExecutionState("error");
    }
  }, [workflow, serverUrl, setExecutionState, resetExecution]);

  // Process individual SSE events
  const handleSSEEvent = useCallback(
    (event: Record<string, unknown>) => {
      switch (event.type) {
        case "workflow:start":
          setWorkflowId(event.workflowId as string);
          break;

        case "subworkflow:expand":
          useDAGStore.getState().setChildWorkflow(
            activeProcessId ?? "null",
            event.parentStageId as string,
            event.childWorkflow as DAGWorkflow,
          );
          break;

        case "stage:start":
          setStageStatus(event.stageId as string, {
            status: "running",
            module: event.module as string,
            attempt: event.attempt as number,
            progress: event.progress as { completed: number; total: number },
          });
          break;

        case "stage:progress":
          // Token streaming — update preview
          setStageStatus(event.stageId as string, {
            preview: (event.token as string) ?? "",
          });
          break;

        case "stage:complete":
          setStageStatus(event.stageId as string, {
            status: "complete",
            durationMs: event.durationMs as number,
            preview: event.preview as string,
            metrics: event.metrics as Record<string, unknown>,
            progress: event.progress as { completed: number; total: number },
          });
          break;

        case "stage:error":
          setStageStatus(event.stageId as string, {
            status: "error",
            error: event.error as string,
          });
          break;

        case "workflow:complete":
          setExecutionState("complete");
          setTotalDuration(event.totalDurationMs as number);
          break;

        case "workflow:error":
          setExecutionState("error");
          break;
      }
    },
    [setStageStatus, setExecutionState, setWorkflowId, setTotalDuration],
  );

  const handleFitView = useCallback(() => {
    reactFlowInstance.fitView({ padding: 0.2 });
  }, [reactFlowInstance]);

  const handleReset = useCallback(() => {
    resetExecution();
  }, [resetExecution]);

  // Selected stage detail panel
  const selectedStage = selectedStageId ? stageStatuses.get(selectedStageId) : null;

  // Tracked processes (for the process selector bar)
  const processEntries = Array.from(trackedProcesses.values());

  return (
    <div className="dag-view">
      <DAGControls
        onRun={handleRun}
        onReset={handleReset}
        onFitView={handleFitView}
        onLoadWorkflow={handleLoadWorkflow}
      />

      <div className="dag-canvas">
        {workflow ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: "smoothstep" }}
          >
            <Background gap={20} size={1} color="var(--border-subtle)" />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor={(n) => {
                if (n.id === "__start__") return "var(--accent)";
                if (n.id === "__end__") return executionState === "complete" ? "var(--success)" : "var(--bg-hover)";
                const s = stageStatuses.get(n.id);
                if (s?.status === "complete") return "var(--success)";
                if (s?.status === "running") return "var(--info)";
                if (s?.status === "error") return "var(--error)";
                return "var(--bg-hover)";
              }}
              maskColor="rgba(0,0,0,0.6)"
              style={{ background: "var(--bg-secondary)" }}
            />
          </ReactFlow>
        ) : (
          <div className="dag-empty">
            <div className="dag-empty-content">
              <span className="dag-empty-icon">🔀</span>
              <h3>No Workflow Loaded</h3>
              <p>Load a workflow from the catalog to visualize and run it.</p>
              <button className="btn-primary btn-lg" onClick={handleLoadWorkflow}>
                📂 Browse Workflows
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Process selector bar — visible when tracking concurrent processes */}
      {processEntries.length > 0 && (
        <div className="dag-process-bar">
          <span className="dag-process-label">Processes:</span>
          {processEntries.map((proc) => (
            <button
              key={proc.id}
              className={`dag-process-btn ${activeProcessId === proc.id ? "active" : ""} process-${proc.status}`}
              onClick={() => setActiveProcess(proc.id)}
              title={`${proc.label} — ${proc.status}`}
            >
              <span className="process-icon">{PROCESS_STATUS_ICONS[proc.status] ?? "○"}</span>
              <span className="process-name">{proc.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Stage detail sidebar */}
      {selectedStage && (
        <div className="dag-inspector">
          <div className="dag-inspector-header">
            <h4>{selectedStage.module}</h4>
            <button className="inspector-close" onClick={() => setSelectedStage(null)}>×</button>
          </div>
          <div className="dag-inspector-body">
            <div className="dag-inspector-row">
              <span className="inspector-label">Stage</span>
              <span className="inspector-value">{selectedStage.stageId}</span>
            </div>
            <div className="dag-inspector-row">
              <span className="inspector-label">Status</span>
              <StageStatusBadge status={selectedStage.status} showLabel />
            </div>
            {selectedStage.durationMs != null && (
              <div className="dag-inspector-row">
                <span className="inspector-label">Duration</span>
                <span className="inspector-value">{(selectedStage.durationMs / 1000).toFixed(2)}s</span>
              </div>
            )}
            {selectedStage.error && (
              <div className="dag-inspector-error">
                <h5>Error</h5>
                <pre>{selectedStage.error}</pre>
              </div>
            )}
            {selectedStage.metrics && Object.keys(selectedStage.metrics).length > 0 && (
              <div className="dag-inspector-metrics">
                <h5>Metrics</h5>
                <pre>{JSON.stringify(selectedStage.metrics, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Workflow catalog overlay */}
      {catalogOpen && (
        <div className="dag-catalog-overlay" onClick={() => setCatalogOpen(false)}>
          <div className="dag-catalog" onClick={(e) => e.stopPropagation()}>
            <div className="dag-catalog-header">
              <h3>Workflow Catalog</h3>
              <button className="inspector-close" onClick={() => setCatalogOpen(false)}>×</button>
            </div>
            <div className="dag-catalog-list">
              {workflows.length === 0 ? (
                <div className="empty-state">No workflows found. Make sure the server is running.</div>
              ) : (
                workflows.map((wf) => (
                  <button
                    key={wf.name}
                    className="dag-catalog-item"
                    onClick={() => handleSelectWorkflow(wf.name)}
                  >
                    <span className="dag-catalog-name">{wf.name}</span>
                    <span className="dag-catalog-meta">
                      v{wf.version} · {Array.isArray(wf.stages) ? wf.stages.length : "?"} stages
                    </span>
                    {wf.description && (
                      <span className="dag-catalog-desc" title={wf.description}>{wf.description}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
