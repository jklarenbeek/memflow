/**
 * DAG Store — Workflow DAG visualization state
 *
 * Manages the React Flow canvas state, workflow stage statuses,
 * and the currently inspected stage for the WorkflowDAG view.
 */
import { create } from "zustand";

export interface DAGStageStatus {
  stageId: string;
  module: string;
  status: "pending" | "running" | "complete" | "error";
  durationMs?: number;
  error?: string;
  preview?: string;
  metrics?: Record<string, unknown>;
  attempt?: number;
  progress?: { completed: number; total: number };
}

export interface DAGWorkflow {
  name: string;
  version: string;
  description?: string;
  entry: string;
  stages: Array<{
    id: string;
    module: string;
    config: Record<string, unknown>;
    next?: string | string[] | Record<string, string> | null;
    dependsOn?: string[];
  }>;
}

export interface DAGState {
  /** The loaded workflow definition */
  workflow: DAGWorkflow | null;
  /** Per-stage status (updated via SSE events) */
  stageStatuses: Map<string, DAGStageStatus>;
  /** Overall workflow execution state */
  executionState: "idle" | "running" | "complete" | "error";
  /** The currently selected stage for the inspector panel */
  selectedStageId: string | null;
  /** Workflow execution ID (from SSE workflow:start event) */
  workflowId: string | null;
  /** Total execution time */
  totalDurationMs: number | null;
  /** Auto-layout algorithm preference */
  layoutDirection: "TB" | "LR";

  // Actions
  loadWorkflow: (workflow: DAGWorkflow) => void;
  setStageStatus: (stageId: string, status: Partial<DAGStageStatus>) => void;
  setExecutionState: (state: DAGState["executionState"]) => void;
  setSelectedStage: (stageId: string | null) => void;
  setWorkflowId: (id: string) => void;
  setTotalDuration: (ms: number) => void;
  setLayoutDirection: (dir: "TB" | "LR") => void;
  resetExecution: () => void;
  clearWorkflow: () => void;
}

export const useDAGStore = create<DAGState>()((set, get) => ({
  workflow: null,
  stageStatuses: new Map(),
  executionState: "idle",
  selectedStageId: null,
  workflowId: null,
  totalDurationMs: null,
  layoutDirection: "TB",

  loadWorkflow: (workflow) => {
    const statuses = new Map<string, DAGStageStatus>();
    for (const stage of workflow.stages) {
      statuses.set(stage.id, {
        stageId: stage.id,
        module: stage.module,
        status: "pending",
      });
    }
    set({
      workflow,
      stageStatuses: statuses,
      executionState: "idle",
      selectedStageId: null,
      workflowId: null,
      totalDurationMs: null,
    });
  },

  setStageStatus: (stageId, status) => {
    const current = get().stageStatuses;
    const updated = new Map(current);
    const existing = updated.get(stageId);
    if (existing) {
      updated.set(stageId, { ...existing, ...status });
    } else {
      updated.set(stageId, {
        stageId,
        module: status.module ?? "unknown",
        status: status.status ?? "pending",
        ...status,
      } as DAGStageStatus);
    }
    set({ stageStatuses: updated });
  },

  setExecutionState: (executionState) => set({ executionState }),

  setSelectedStage: (selectedStageId) => set({ selectedStageId }),

  setWorkflowId: (workflowId) => set({ workflowId }),

  setTotalDuration: (totalDurationMs) => set({ totalDurationMs }),

  setLayoutDirection: (layoutDirection) => set({ layoutDirection }),

  resetExecution: () => {
    const workflow = get().workflow;
    if (!workflow) return;
    const statuses = new Map<string, DAGStageStatus>();
    for (const stage of workflow.stages) {
      statuses.set(stage.id, {
        stageId: stage.id,
        module: stage.module,
        status: "pending",
      });
    }
    set({
      stageStatuses: statuses,
      executionState: "idle",
      workflowId: null,
      totalDurationMs: null,
    });
  },

  clearWorkflow: () =>
    set({
      workflow: null,
      stageStatuses: new Map(),
      executionState: "idle",
      selectedStageId: null,
      workflowId: null,
      totalDurationMs: null,
    }),
}));
