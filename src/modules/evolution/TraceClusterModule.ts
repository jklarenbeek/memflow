/**
 * TraceClusterModule — embed and cluster execution traces
 *
 * Inspired by Trace2Skill (2603.25158): groups experience entries into
 * semantically coherent clusters for downstream skill distillation.
 *
 * Reads:  experienceLibrary
 * Writes: traceClusters
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  ExperienceEntry,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { kMeans } from "../../utils/clustering.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  clusteringBackend: z.enum(["builtin", "ml-matrix"]).default("builtin"),
  k: z.number().min(2).max(50).default(5),
  maxIterations: z.number().default(100),
  maxTrajectories: z.number().default(2000),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class TraceClusterModule implements BaseModule<Config> {
  readonly name = "TraceCluster";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    // Get experience library from workflow data or Memgraph
    let experiences: ExperienceEntry[] = input.data.experienceLibrary ?? [];

    if (experiences.length === 0) {
      // Try loading from Memgraph ModuleState
      try {
        const states = await ctx.memgraph.query<{ data: string }>(`
          MATCH (ms:ModuleState)
          WHERE ms.moduleKey STARTS WITH 'ExperienceReflector'
          RETURN ms.data AS data
          ORDER BY ms.updatedAt DESC
          LIMIT $limit
        `, { limit: config.maxTrajectories });

        for (const s of states) {
          try {
            const parsed = JSON.parse(s.data);
            if (parsed.context && parsed.insight) {
              experiences.push({
                context: parsed.context,
                insight: parsed.insight,
                utility: parsed.utility ?? 0.5,
              });
            }
          } catch { /* skip unparseable */ }
        }
      } catch (err) {
        ctx.logger.debug(`TraceCluster: ModuleState query failed: ${(err as Error).message}`);
      }
    }

    // Down-sample if needed
    if (experiences.length > config.maxTrajectories) {
      experiences = experiences.slice(0, config.maxTrajectories);
    }

    if (experiences.length < config.k) {
      ctx.logger.info(`TraceCluster: Not enough experiences (${experiences.length}) for k=${config.k} clusters`);
      return {
        data: { traceClusters: [] },
        metrics: { clusterCount: 0, experienceCount: experiences.length },
      };
    }

    // Embed each experience
    const embeddings = ctx.getEmbeddings();
    const texts = experiences.map((e) => `${e.context} ${e.insight}`);
    const vectors = await embeddings.embedDocuments(texts);

    // Run k-means
    const { centroids, assignments } = config.clusteringBackend === "builtin"
      ? kMeans(vectors, config.k, config.maxIterations)
      : await this.mlMatrixKMeans(vectors, config.k, config.maxIterations);

    // Build cluster result
    const clusters: Array<{ centroid: number[]; members: ExperienceEntry[] }> = [];
    for (let c = 0; c < centroids.length; c++) {
      const members = experiences.filter((_, i) => assignments[i] === c);
      if (members.length > 0) {
        clusters.push({ centroid: centroids[c], members });
      }
    }

    ctx.logger.info(`TraceCluster: Formed ${clusters.length} clusters from ${experiences.length} experiences`);

    return {
      data: { traceClusters: clusters },
      metrics: {
        clusterCount: clusters.length,
        experienceCount: experiences.length,
      },
    };
  }

  /**
   * ml-matrix k-means backend (optional dependency).
   * Falls back to builtin if ml-matrix is not installed.
   */
  private async mlMatrixKMeans(
    vectors: number[][],
    k: number,
    maxIterations: number,
  ): Promise<{ centroids: number[][]; assignments: number[] }> {
    try {
      const { kMeans: mlKMeans } = await import("ml-kmeans" as string);
      const result = mlKMeans(vectors, k, { maxIterations });
      return {
        centroids: result.centroids,
        assignments: result.clusters,
      };
    } catch {
      // Fall back to builtin
      const result = kMeans(vectors, k, maxIterations);
      return { centroids: result.centroids, assignments: result.assignments };
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
