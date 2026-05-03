/**
 * MemFlow Metrics — Prometheus instrumentation wired into WorkflowEventEmitter
 *
 * Provides:
 *  - Stage latency histogram (`stage_duration_seconds`)
 *  - Stage error counter (`stage_errors_total`)
 *  - Workflow run counter (`workflow_runs_total`)
 *  - Workflow duration histogram (`workflow_duration_seconds`)
 *  - Active workflow gauge (`active_workflows`)
 *
 * Usage:
 *   import { wireEngineMetrics, metricsHandler } from "./metrics.js";
 *   wireEngineMetrics(engine);
 *   app.get("/metrics", metricsHandler);
 */

import { Registry, Histogram, Counter, Gauge } from "prom-client";
import type { WorkflowEngine } from "../core/WorkflowEngine.js";
import type {
  StreamEventStageComplete,
  StreamEventStageError,
  StreamEventWorkflowStart,
  StreamEventWorkflowComplete,
  StreamEventWorkflowError,
  StreamEventPatternEvent,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const register = new Registry();

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const stageDurationHistogram = new Histogram({
  name: "stage_duration_seconds",
  help: "Stage execution latency in seconds",
  labelNames: ["module", "stage_id"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const stageErrorCounter = new Counter({
  name: "stage_errors_total",
  help: "Total number of stage execution errors",
  labelNames: ["module", "will_retry"],
  registers: [register],
});

export const workflowRunsCounter = new Counter({
  name: "workflow_runs_total",
  help: "Total number of workflow runs",
  labelNames: ["workflow_name", "status"],
  registers: [register],
});

export const workflowDurationHistogram = new Histogram({
  name: "workflow_duration_seconds",
  help: "End-to-end workflow latency in seconds",
  labelNames: ["workflow_name"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const activeWorkflowsGauge = new Gauge({
  name: "active_workflows",
  help: "Number of workflows currently running",
  registers: [register],
});

// GMPL pattern metrics

export const gmplPatternRoundsCounter = new Counter({
  name: "gmpl_pattern_rounds_total",
  help: "Total rounds executed across GMPL patterns",
  labelNames: ["pattern_id", "event_name"],
  registers: [register],
});

export const gmplPatternDurationHistogram = new Histogram({
  name: "gmpl_pattern_duration_seconds",
  help: "GMPL pattern execution latency in seconds",
  labelNames: ["pattern_id"],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [register],
});

export const gmplErrorsCounter = new Counter({
  name: "gmpl_errors_total",
  help: "Total GMPL-specific errors by error code",
  labelNames: ["error_code", "pattern_id"],
  registers: [register],
});

/**
 * Record a GMPL error for Prometheus tracking.
 *
 * Call from catch blocks that handle GmplError subclasses:
 *
 *   catch (err) {
 *     if (err instanceof GmplError) recordGmplError(err.code, patternId);
 *   }
 */
export function recordGmplError(errorCode: string, patternId = "unknown"): void {
  gmplErrorsCounter.inc({ error_code: errorCode, pattern_id: patternId });
}

// G2 — Additional pattern-level observability metrics

export const gmplClarificationTurnsCounter = new Counter({
  name: "gmpl_clarification_turns_total",
  help: "Total clarification turns across GMPL patterns",
  labelNames: ["pattern_id"],
  registers: [register],
});

export const gmplConsensusQualityGauge = new Gauge({
  name: "gmpl_consensus_quality_score",
  help: "Latest consensus quality/convergence score by pattern",
  labelNames: ["pattern_id"],
  registers: [register],
});

export const gmplPendingResolutionHistogram = new Histogram({
  name: "gmpl_pending_resolution_latency",
  help: "Latency between pending decision creation and resolution (seconds)",
  labelNames: ["pattern_id"],
  buckets: [60, 300, 900, 3600, 86400, 604800, 2592000],
  registers: [register],
});

// Evolution Layer metrics (§8)

export const evolutionDatasetExportsCounter = new Counter({
  name: "memflow_dataset_exports_total",
  help: "Total number of SLM dataset exports",
  registers: [register],
});

export const evolutionDatasetSamplesCounter = new Counter({
  name: "memflow_dataset_samples_total",
  help: "Total training samples exported by type",
  labelNames: ["type"],
  registers: [register],
});

export const evolutionSkillsDistilledCounter = new Counter({
  name: "memflow_skills_distilled_total",
  help: "Total skills distilled via Trace2Skill pipeline",
  registers: [register],
});

export const evolutionSkillInjectionsCounter = new Counter({
  name: "memflow_skill_injections_total",
  help: "Total skill injections into downstream modules",
  registers: [register],
});

export const evolutionHarnessVersionsCounter = new Counter({
  name: "memflow_harness_versions_total",
  help: "Total harness versions generated by HarnessEvolver",
  registers: [register],
});

export const evolutionHarnessRetrospectiveCounter = new Counter({
  name: "memflow_harness_retrospective_results",
  help: "Retrospective validation outcomes",
  labelNames: ["result"],
  registers: [register],
});

export const evolutionIntentCompilationsCounter = new Counter({
  name: "memflow_intent_compilations_total",
  help: "Total IntentCompiler workflow generation attempts",
  labelNames: ["result"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

/**
 * Track in-flight workflow start times so we can compute total duration
 * when workflow:complete / workflow:error fires.
 */
interface WorkflowStartInfo {
  startMs: number;
  name: string;
}
const workflowStartInfo = new Map<string, WorkflowStartInfo>();

/** Maximum age (ms) for a workflow start entry before it is considered stale. */
const WORKFLOW_START_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Remove stale entries from the workflowStartInfo map to prevent slow leaks. */
function sweepStaleEntries(): void {
  const now = Date.now();
  for (const [id, info] of workflowStartInfo) {
    if (now - info.startMs > WORKFLOW_START_TTL_MS) {
      workflowStartInfo.delete(id);
    }
  }
}

/**
 * Subscribe to a WorkflowEngine's event emitter and record Prometheus metrics.
 *
 * This should be called once per engine, ideally right after initialization:
 *
 *   const engine = new WorkflowEngine(config);
 *   await engine.initialize(globalConfig);
 *   wireEngineMetrics(engine);
 */
export function wireEngineMetrics(engine: WorkflowEngine): void {
  const ee = engine.events;

  ee.on("workflow:start", (event: StreamEventWorkflowStart) => {
    sweepStaleEntries();
    workflowStartInfo.set(event.workflowId, { startMs: Date.now(), name: event.name });
    activeWorkflowsGauge.inc();
  });

  ee.on("stage:complete", (event: StreamEventStageComplete) => {
    const seconds = event.durationMs / 1000;
    stageDurationHistogram.observe(
      { module: event.module, stage_id: event.stageId },
      seconds,
    );

    // G1: When this stage is a GMPL module, also observe pattern-level duration
    const patternId = event.metrics?._patternId as string | undefined;
    if (patternId) {
      gmplPatternDurationHistogram.observe({ pattern_id: patternId }, seconds);
    }
  });

  ee.on("stage:error", (event: StreamEventStageError) => {
    stageErrorCounter.inc({
      module: event.module,
      will_retry: String(event.willRetry),
    });
  });

  ee.on("workflow:complete", (event: StreamEventWorkflowComplete) => {
    activeWorkflowsGauge.dec();
    const info = workflowStartInfo.get(event.workflowId);
    if (info !== undefined) {
      const seconds = (Date.now() - info.startMs) / 1000;
      workflowDurationHistogram.observe({ workflow_name: info.name }, seconds);
      workflowStartInfo.delete(event.workflowId);
    }
    workflowRunsCounter.inc({ workflow_name: info?.name ?? event.workflowId, status: "complete" });
  });

  ee.on("workflow:error", (event: StreamEventWorkflowError) => {
    activeWorkflowsGauge.dec();
    const info = workflowStartInfo.get(event.workflowId);
    if (info !== undefined) {
      const seconds = (Date.now() - info.startMs) / 1000;
      workflowDurationHistogram.observe({ workflow_name: info.name }, seconds);
      workflowStartInfo.delete(event.workflowId);
    }
    workflowRunsCounter.inc({ workflow_name: info?.name ?? event.workflowId, status: "error" });
  });

  // GMPL pattern events — discriminated by eventName
  ee.on("pattern:event", (event: StreamEventPatternEvent) => {
    // Always track round-level counters
    gmplPatternRoundsCounter.inc({
      pattern_id: event.patternId,
      event_name: event.eventName,
    });

    // G2: Supplemental observability by event type
    switch (event.eventName) {
      case "clarification:question":
        gmplClarificationTurnsCounter.inc({ pattern_id: event.patternId });
        break;

      case "debate:position":
      case "delphi:converged": {
        const score = event.payload.convergenceScore as number | undefined;
        if (score !== undefined) {
          gmplConsensusQualityGauge.set({ pattern_id: event.patternId }, score);
        }
        break;
      }

      case "memory:resolved": {
        const latencySeconds = event.payload.resolutionLatencySeconds as number | undefined;
        if (latencySeconds !== undefined) {
          gmplPendingResolutionHistogram.observe(
            { pattern_id: event.patternId },
            latencySeconds,
          );
        }
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

import type { Context } from "hono";

/**
 * Hono handler for `GET /metrics`.
 *
 * Returns the current Prometheus exposition format.
 */
export async function metricsHandler(c: Context): Promise<Response> {
  const metrics = await register.metrics();
  return c.text(metrics, 200, {
    "Content-Type": register.contentType,
  });
}
