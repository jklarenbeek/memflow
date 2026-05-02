/**
 * GraphPersistModule — persist memory units to Memgraph
 *
 * Extracted from StructMem. Writes enriched memory units and their
 * relations to the graph database using parameterised queries.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — passthrough
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Max units to persist per batch */
  batchSize: z.number().default(50),
  /** Whether to actually persist (set to false for dry-run) */
  enabled: z.boolean().default(true),
});

type GraphPersistConfig = z.infer<typeof ConfigSchema>;

export class GraphPersistModule implements BaseModule<GraphPersistConfig> {
  readonly name = "GraphPersist";
  readonly version = "0.5.0";
  private config: GraphPersistConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<GraphPersistConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0 || !this.config.enabled) {
      return {
        data: { memoryUnits: units },
        metrics: { persisted: 0 },
      };
    }

    const batch = units.slice(-this.config.batchSize);

    try {
      await ctx.memgraph.persistMemoryUnits(
        batch.map((u) => ({
          id: u.id,
          content: u.content,
          embedding: u.embedding,
          type: u.type,
          timestamp: u.timestamp.toISOString?.() ?? new Date().toISOString(),
          metadata: u.metadata,
          relations: u.relations,
        })),
      );
      ctx.logger.info(`GraphPersist: Persisted ${batch.length} units to Memgraph`);
    } catch (err) {
      ctx.logger.warn(
        `GraphPersist: Persistence failed: ${(err as Error).message}`,
      );
    }

    return {
      data: { memoryUnits: units },
      metrics: { persisted: batch.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
