/**
 * CrystallizerModule — merge near-duplicate memories into canonical forms
 *
 * Finds MemoryUnit nodes with high cosine similarity and merges them,
 * preserving the strongest relations and boosting confidence.
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";

const ConfigSchema = z.object({
  similarityThreshold: z.number().default(0.92),
  batchSize: z.number().default(50),
  enabled: z.boolean().default(true),
});

type Config = z.infer<typeof ConfigSchema>;

export class CrystallizerModule implements BaseModule<Config> {
  readonly name = "Crystallizer";
  readonly version = "0.5.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    if (!this.config.enabled) {
      return { data: {}, metrics: { crystallized: 0 } };
    }

    try {
      const units = await ctx.memgraph.query<{ id: string; content: string; embedding: number[]; confidence: number }>(
        `MATCH (m:MemoryUnit)
         WHERE m.deletedAt IS NULL
         RETURN m.id AS id, m.content AS content, m.embedding AS embedding, m.confidence AS confidence
         LIMIT $limit`,
        { limit: this.config.batchSize },
      );

      const merges: Array<{ keepId: string; removeId: string }> = [];

      for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
          const a = units[i];
          const b = units[j];
          if (!a.embedding || !b.embedding) continue;

          const sim = cosineSimilarity(a.embedding, b.embedding);
          if (sim >= this.config.similarityThreshold) {
            // Keep the one with higher confidence
            const keep = a.confidence >= b.confidence ? a : b;
            const remove = a.confidence >= b.confidence ? b : a;
            merges.push({ keepId: keep.id, removeId: remove.id });
          }
        }
      }

      // Deduplicate merges (a node might be similar to multiple others)
      const uniqueRemoves = new Set<string>();
      const finalMerges: typeof merges = [];
      for (const m of merges) {
        if (!uniqueRemoves.has(m.removeId) && !uniqueRemoves.has(m.keepId)) {
          uniqueRemoves.add(m.removeId);
          finalMerges.push(m);
        }
      }

      // Execute merges in graph
      for (const m of finalMerges) {
        await ctx.memgraph.query(
          `MATCH (keep:MemoryUnit {id: $keepId})
           MATCH (remove:MemoryUnit {id: $removeId})
           OPTIONAL MATCH (remove)-[r]->(t)
           WITH keep, remove, collect({type: type(r), target: t.id, weight: r.weight}) as rels
           SET keep.confidence = clamp(keep.confidence + 0.05, 0.1, 1.0),
               keep.crystallizedAt = $timestamp,
               keep.originalIds = coalesce(keep.originalIds, []) + remove.id
           FOREACH (rel IN rels |
             MERGE (keep)-[nr:MEMORY_RELATION {relType: rel.type}]->(:MemoryUnit {id: rel.target})
             SET nr.weight = coalesce(nr.weight, 0) + coalesce(rel.weight, 0.5)
           )
           DETACH DELETE remove`,
          { keepId: m.keepId, removeId: m.removeId, timestamp: new Date().toISOString() },
        );
      }

      ctx.logger.info(`Crystallizer: Merged ${finalMerges.length} near-duplicate memories`);

      return {
        data: {},
        metrics: { crystallized: finalMerges.length, examined: units.length },
      };
    } catch (err) {
      ctx.logger.warn(`Crystallizer: failed: ${(err as Error).message}`);
      return { data: {}, metrics: { crystallized: 0, error: 1 } };
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
