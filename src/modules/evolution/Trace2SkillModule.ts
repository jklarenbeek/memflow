/**
 * Trace2SkillModule — composite wrapper for trace-to-skill distillation
 *
 * Orchestrates the full Trace2Skill pipeline: cluster → analyze → merge.
 * Delegates to the `trace2skill-pipeline.json` sub-workflow.
 *
 * Reads:  experienceLibrary (or queries from Memgraph)
 * Writes: distilledSkills
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

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
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    // Import and run the sub-workflow inline
    // This composite module orchestrates: TraceCluster → SkillMerge
    const { TraceClusterModule } = await import("./TraceClusterModule.js");
    const { SkillMergeModule } = await import("./SkillMergeModule.js");

    // Stage 1: Cluster
    const clusterModule = new TraceClusterModule({
      k: config.k,
      clusteringBackend: config.clusteringBackend,
    });
    const clusterResult = await clusterModule.process(
      { data: input.data, config: clusterModule.getConfigSchema().parse({
        k: config.k,
        clusteringBackend: config.clusteringBackend,
      }) },
      context,
    );

    // Stage 2: Merge
    const mergeModule = new SkillMergeModule({
      maxSkillsPerCluster: config.maxSkillsPerCluster,
      persistToGraph: config.persistToGraph,
    });
    const mergeResult = await mergeModule.process(
      {
        data: { ...input.data, ...clusterResult.data },
        config: mergeModule.getConfigSchema().parse({
          maxSkillsPerCluster: config.maxSkillsPerCluster,
          persistToGraph: config.persistToGraph,
        }),
      },
      context,
    );

    const skillCount = (mergeResult.metrics?.skillCount as number) ?? 0;
    ctx.logger.info(`Trace2Skill: Complete — ${skillCount} skills distilled`);

    return {
      data: {
        traceClusters: clusterResult.data.traceClusters,
        distilledSkills: mergeResult.data.distilledSkills,
      },
      metrics: {
        ...clusterResult.metrics,
        ...mergeResult.metrics,
      },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
