/**
 * Trace2SkillModule — composite wrapper for trace-to-skill distillation
 *
 * Orchestrates the full Trace2Skill pipeline: cluster → merge.
 * Delegates to the `trace2skill-pipeline.json` sub-workflow via
 * ctx.runSubWorkflow(), ensuring:
 *  - Full tracing via ctx.addTrace()
 *  - Event emission through WorkflowEventEmitter
 *  - Prometheus metrics collection
 *  - Module instance caching via ModuleRegistry
 *  - Recursion depth guard
 *
 * Reads:  experienceLibrary (or queries from Memgraph)
 * Writes: distilledSkills
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Number of clusters for the TraceCluster stage */
  k: z.number().min(2).max(50).default(5),
  clusteringBackend: z.enum(["builtin", "ml-matrix"]).default("builtin"),
  maxSkillsPerCluster: z.number().default(3),
  /** Persist skills to Memgraph */
  persistToGraph: z.boolean().default(true),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class Trace2SkillModule implements BaseModule<Config> {
  readonly name = "Trace2Skill";
  readonly version = "0.3.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    // Load the trace2skill-pipeline.json sub-workflow definition
    const workflowConfig = this.loadPipelineWorkflow();

    // Build per-stage config overrides from Trace2Skill's merged config
    const stageOverrides: Record<string, Record<string, unknown>> = {
      cluster: {
        k: config.k,
        clusteringBackend: config.clusteringBackend,
      },
      merge: {
        maxSkillsPerCluster: config.maxSkillsPerCluster,
        persistToGraph: config.persistToGraph,
      },
    };

    // Execute as a proper sub-workflow via ctx.runSubWorkflow(),
    // sharing the parent WorkflowContext (LLM, Memgraph, Logger, tracing)
    const childState = await ctx.runSubWorkflow(
      workflowConfig,
      input.data,
      stageOverrides,
    );

    const skillCount = (childState.data.metrics as Record<string, unknown>)?.skillCount ?? 0;
    ctx.logger.info(`Trace2Skill: Complete — ${skillCount} skills distilled via sub-workflow`);

    return {
      data: {
        traceClusters: childState.data.traceClusters,
        distilledSkills: childState.data.distilledSkills,
      },
      metrics: {
        ...(childState.data.metrics as Record<string, unknown> ?? {}),
        subWorkflow: "trace2skill-pipeline",
        childStages: workflowConfig.stages.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Pipeline loading
  // -----------------------------------------------------------------------

  private loadPipelineWorkflow() {
    const thisFile =
      typeof __filename !== "undefined"
        ? __filename
        : fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(thisFile), "..", "..", "..");
    const pipelinePath = path.join(
      projectRoot, "src", "workflows", "sub", "trace2skill-pipeline.json",
    );
    const raw = fs.readFileSync(pipelinePath, "utf-8");
    return JSON.parse(raw);
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
