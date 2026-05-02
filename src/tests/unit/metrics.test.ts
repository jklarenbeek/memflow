import { describe, test, expect } from "bun:test";
import { WorkflowEventEmitter } from "../../core/WorkflowEventEmitter.js";
import {
  register,
  wireEngineMetrics,
  stageDurationHistogram,
  stageErrorCounter,
  workflowRunsCounter,
  workflowDurationHistogram,
  activeWorkflowsGauge,
} from "../../server/metrics.js";
import type {
  StreamEventWorkflowStart,
  StreamEventStageComplete,
  StreamEventStageError,
  StreamEventWorkflowComplete,
  StreamEventWorkflowError,
} from "../../core/types.js";

// Reset registry before each test to avoid label collisions
function resetRegistry(): void {
  register.resetMetrics();
}

function makeWorkflowStart(overrides: Partial<StreamEventWorkflowStart> = {}): StreamEventWorkflowStart {
  return {
    type: "workflow:start",
    workflowId: "w1",
    name: "test-flow",
    stages: ["s1"],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeStageComplete(overrides: Partial<StreamEventStageComplete> = {}): StreamEventStageComplete {
  return {
    type: "stage:complete",
    stageId: "s1",
    module: "TestModule",
    durationMs: 100,
    progress: { completed: 1, total: 1 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeStageError(overrides: Partial<StreamEventStageError> = {}): StreamEventStageError {
  return {
    type: "stage:error",
    stageId: "s1",
    module: "TestModule",
    error: "boom",
    attempt: 1,
    maxAttempts: 3,
    willRetry: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeWorkflowComplete(overrides: Partial<StreamEventWorkflowComplete> = {}): StreamEventWorkflowComplete {
  return {
    type: "workflow:complete",
    workflowId: "w1",
    totalDurationMs: 200,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeWorkflowError(overrides: Partial<StreamEventWorkflowError> = {}): StreamEventWorkflowError {
  return {
    type: "workflow:error",
    workflowId: "w1",
    error: "fail",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("wireEngineMetrics", () => {
  test("records stage duration on stage:complete", async () => {
    resetRegistry();
    const emitter = new WorkflowEventEmitter();
    wireEngineMetrics({ events: emitter } as any);

    emitter.emit(makeStageComplete({ durationMs: 500 }));

    const metrics = await register.metrics();
    expect(metrics).toContain('stage_duration_seconds_bucket{le="0.5",module="TestModule",stage_id="s1"}');
    expect(metrics).toContain('stage_duration_seconds_count{module="TestModule",stage_id="s1"}');
  });

  test("records stage errors on stage:error", async () => {
    resetRegistry();
    const emitter = new WorkflowEventEmitter();
    wireEngineMetrics({ events: emitter } as any);

    emitter.emit(makeStageError({ willRetry: true }));
    emitter.emit(makeStageError({ willRetry: false }));

    const metrics = await register.metrics();
    expect(metrics).toContain('stage_errors_total{module="TestModule",will_retry="true"}');
    expect(metrics).toContain('stage_errors_total{module="TestModule",will_retry="false"}');
  });

  test("tracks active workflows and workflow duration", async () => {
    resetRegistry();
    const emitter = new WorkflowEventEmitter();
    wireEngineMetrics({ events: emitter } as any);

    emitter.emit(makeWorkflowStart());
    const gauge1 = await activeWorkflowsGauge.get();
    expect(gauge1.values).toEqual([{ value: 1, labels: {} }]);

    emitter.emit(makeWorkflowComplete());
    const gauge0 = await activeWorkflowsGauge.get();
    expect(gauge0.values).toEqual([{ value: 0, labels: {} }]);

    const metrics = await register.metrics();
    expect(metrics).toContain('workflow_runs_total{workflow_name="test-flow",status="complete"}');
    expect(metrics).toContain('workflow_duration_seconds_count{workflow_name="test-flow"}');
  });

  test("tracks workflow errors correctly", async () => {
    resetRegistry();
    const emitter = new WorkflowEventEmitter();
    wireEngineMetrics({ events: emitter } as any);

    emitter.emit(makeWorkflowStart());
    emitter.emit(makeWorkflowError());

    const metrics = await register.metrics();
    expect(metrics).toContain('workflow_runs_total{workflow_name="test-flow",status="error"}');
  });

  test("handles concurrent workflows", async () => {
    resetRegistry();
    const emitter = new WorkflowEventEmitter();
    wireEngineMetrics({ events: emitter } as any);

    emitter.emit(makeWorkflowStart({ workflowId: "w1", name: "flow-a" }));
    emitter.emit(makeWorkflowStart({ workflowId: "w2", name: "flow-b" }));
    const gauge2 = await activeWorkflowsGauge.get();
    expect(gauge2.values).toEqual([{ value: 2, labels: {} }]);

    emitter.emit(makeWorkflowComplete({ workflowId: "w1" }));
    const gauge1b = await activeWorkflowsGauge.get();
    expect(gauge1b.values).toEqual([{ value: 1, labels: {} }]);

    emitter.emit(makeWorkflowComplete({ workflowId: "w2" }));
    const gauge0b = await activeWorkflowsGauge.get();
    expect(gauge0b.values).toEqual([{ value: 0, labels: {} }]);
  });
});

describe("metricsHandler", () => {
  test("returns Prometheus exposition format", async () => {
    resetRegistry();
    const { metricsHandler } = await import("../../server/metrics.js");

    const mockContext = {
      text: (body: string, status: number, headers: Record<string, string>) =>
        new Response(body, { status, headers }),
    };

    const response = await metricsHandler(mockContext as any);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("# HELP");
  });
});
