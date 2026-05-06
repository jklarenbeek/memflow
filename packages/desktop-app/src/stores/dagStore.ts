/**
 * DAG Store — Workflow DAG visualization state
 *
 * Manages the React Flow canvas state, workflow stage statuses,
 * and the currently inspected stage for the WorkflowDAG view.
 * Supports tracking multiple concurrent processes (e.g. file ingestions)
 * with a process selector bar.
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

/** A tracked concurrent process (e.g. one file ingestion) */
export interface TrackedProcess {
  id: string;
  label: string;
  workflow: DAGWorkflow;
  status: "running" | "complete" | "error";
  stageStatuses: Map<string, DAGStageStatus>;
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
  /** Multiple concurrent processes tracked for process selector */
  trackedProcesses: Map<string, TrackedProcess>;
  /** Which process is currently visualised */
  activeProcessId: string | null;

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

  // Multi-process actions
  trackProcess: (id: string, label: string, workflow: DAGWorkflow) => void;
  updateProcessStage: (processId: string, stageId: string, status: Partial<DAGStageStatus>) => void;
  setProcessComplete: (processId: string) => void;
  setProcessError: (processId: string) => void;
  setActiveProcess: (processId: string | null) => void;
  removeProcess: (processId: string) => void;
}

/** Build initial pending stage statuses for a workflow */
function buildPendingStatuses(workflow: DAGWorkflow): Map<string, DAGStageStatus> {
  const statuses = new Map<string, DAGStageStatus>();
  for (const stage of workflow.stages) {
    statuses.set(stage.id, {
      stageId: stage.id,
      module: stage.module,
      status: "pending",
    });
  }
  return statuses;
}

export const useDAGStore = create<DAGState>()((set, get) => ({
  workflow: null,
  stageStatuses: new Map(),
  executionState: "idle",
  selectedStageId: null,
  workflowId: null,
  totalDurationMs: null,
  layoutDirection: "TB",
  trackedProcesses: new Map(),
  activeProcessId: null,

  loadWorkflow: (workflow) => {
    set({
      workflow,
      stageStatuses: buildPendingStatuses(workflow),
      executionState: "idle",
      selectedStageId: null,
      workflowId: null,
      totalDurationMs: null,
      activeProcessId: null,
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
    set({
      stageStatuses: buildPendingStatuses(workflow),
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
      activeProcessId: null,
    }),

  // ---------------------------------------------------------------------------
  // Multi-process tracking
  // ---------------------------------------------------------------------------

  trackProcess: (id, label, workflow) => {
    const processes = new Map(get().trackedProcesses);
    processes.set(id, {
      id,
      label,
      workflow,
      status: "running",
      stageStatuses: buildPendingStatuses(workflow),
    });
    set({ trackedProcesses: processes });
  },

  updateProcessStage: (processId, stageId, status) => {
    const processes = new Map(get().trackedProcesses);
    const proc = processes.get(processId);
    if (!proc) return;

    const updated = new Map(proc.stageStatuses);
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
    processes.set(processId, { ...proc, stageStatuses: updated });
    set({ trackedProcesses: processes });

    // If this process is currently active, also update the main stageStatuses
    if (get().activeProcessId === processId) {
      set({ stageStatuses: new Map(updated) });
    }
  },

  setProcessComplete: (processId) => {
    const processes = new Map(get().trackedProcesses);
    const proc = processes.get(processId);
    if (!proc) return;
    processes.set(processId, { ...proc, status: "complete" });
    set({ trackedProcesses: processes });

    if (get().activeProcessId === processId) {
      set({ executionState: "complete" });
    }
  },

  setProcessError: (processId) => {
    const processes = new Map(get().trackedProcesses);
    const proc = processes.get(processId);
    if (!proc) return;
    processes.set(processId, { ...proc, status: "error" });
    set({ trackedProcesses: processes });

    if (get().activeProcessId === processId) {
      set({ executionState: "error" });
    }
  },

  setActiveProcess: (processId) => {
    if (!processId) {
      set({ activeProcessId: null });
      return;
    }
    const proc = get().trackedProcesses.get(processId);
    if (!proc) return;

    // Load this process's workflow and stage statuses into the main view
    set({
      activeProcessId: processId,
      workflow: proc.workflow,
      stageStatuses: new Map(proc.stageStatuses),
      executionState: proc.status === "complete" ? "complete" : proc.status === "error" ? "error" : "running",
      selectedStageId: null,
      workflowId: processId,
    });
  },

  removeProcess: (processId) => {
    const processes = new Map(get().trackedProcesses);
    processes.delete(processId);
    const patch: Partial<DAGState> = { trackedProcesses: processes };

    // If the removed process was active, clear the DAG view
    if (get().activeProcessId === processId) {
      patch.activeProcessId = null;
      patch.workflow = null;
      patch.stageStatuses = new Map();
      patch.executionState = "idle";
      patch.selectedStageId = null;
      patch.workflowId = null;
    }
    set(patch as DAGState);
  },
}));
