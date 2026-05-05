import './DAG.css';
/**
 * WorkflowDAG — Interactive workflow DAG visualizer
 *
 * Renders the workflow stages as a directed acyclic graph using React Flow.
 * Features:
 *  - Auto-layout with dagre (TB/LR direction)
 *  - Real-time status updates via SSE during execution
 *  - Click-to-inspect stage details
 *  - Workflow loading from the catalog
 *  - Run workflow with streaming progress
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
import { DAGControls } from "./DAGControls";
import { StageStatusBadge } from "./StageStatusBadge";
import { useDAGStore, type DAGWorkflow } from "../../stores/dagStore";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

// ---------------------------------------------------------------------------
// Node types registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes = { stage: StageNode } as any;

// ---------------------------------------------------------------------------
// Layout helper (simplified dagre-like layout without external dep)
// ---------------------------------------------------------------------------

function layoutWorkflow(
  workflow: DAGWorkflow,
  direction: "TB" | "LR",
): { nodes: Node<StageNodeData>[]; edges: Edge[] } {
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
  const nodes: Node<StageNodeData>[] = [];
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const layerWidth = layer.length * (nodeWidth + hGap) - hGap;
    const startX = -layerWidth / 2;

    for (let nodeIdx = 0; nodeIdx < layer.length; nodeIdx++) {
      const stageId = layer[nodeIdx];
      const stage = stageMap.get(stageId);
      if (!stage) continue;

      const x = direction === "TB"
        ? startX + nodeIdx * (nodeWidth + hGap)
        : layerIdx * (nodeWidth + hGap);
      const y = direction === "TB"
        ? layerIdx * (nodeHeight + vGap)
        : startX + nodeIdx * (nodeHeight + vGap);

      nodes.push({
        id: stageId,
        type: "stage",
        position: { x, y },
        data: {
          stageId,
          module: stage.module,
          status: "pending",
          isEntry: stageId === workflow.entry,
          isTerminal: !stage.next || (typeof stage.next === "string" && !stage.next),
        },
      });
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// WorkflowDAG Component
// ---------------------------------------------------------------------------

export function WorkflowDAG() {
  const { workflow, stageStatuses, selectedStageId, layoutDirection } = useDAGStore();
  const { loadWorkflow, setStageStatus, setExecutionState, setSelectedStage, setWorkflowId, setTotalDuration, resetExecution } = useDAGStore();
  const serverUrl = useAppStore((s) => s.serverUrl);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StageNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [workflows, setWorkflows] = useState<Array<{ name: string; version: string; description?: string; stages: unknown[] }>>([]);
  const reactFlowInstance = useReactFlow();

  // Layout nodes when workflow or direction changes
  useEffect(() => {
    if (!workflow) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const layout = layoutWorkflow(workflow, layoutDirection);
    setNodes(layout.nodes);
    setEdges(layout.edges);
    // Fit view after layout
    setTimeout(() => reactFlowInstance.fitView({ padding: 0.2 }), 50);
  }, [workflow, layoutDirection, setNodes, setEdges, reactFlowInstance]);

  // Update node data when stage statuses change
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
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
        const sourceStatus = stageStatuses.get(edge.source);
        const isRunning = sourceStatus?.status === "running";
        const isComplete = sourceStatus?.status === "complete";
        return {
          ...edge,
          animated: isRunning,
          style: {
            ...edge.style,
            stroke: isComplete ? "var(--success)" : isRunning ? "var(--info)" : "var(--border)",
          },
        };
      }),
    );
  }, [stageStatuses, setEdges]);

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
                      <span className="dag-catalog-desc">{wf.description}</span>
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
