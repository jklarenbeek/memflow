/**
 * NoveltyGateModule — cosine-based novelty filtering
 *
 * Extracted from LightMem Tier 1 (Sensory Memory). Filters incoming
 * memory units by novelty — only units that are sufficiently different
 * from existing memories pass through.
 *
 * Uses Memgraph StateStore for crash-recoverable sensory buffer state.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — novel units only
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { similarity, type SimilarityFunction } from "../../utils/similarity.js";

const ConfigSchema = z.object({
  /** Similarity threshold — units above this are considered duplicates */
  noveltyThreshold: z.number().min(0).max(1).default(0.75),
  /** Similarity function for novelty comparison (Improvement #14) */
  similarityFunction: z.enum(["cosine", "euclidean", "dotProduct"]).default("cosine"),
});

type NoveltyGateConfig = z.infer<typeof ConfigSchema>;

export class NoveltyGateModule implements BaseModule<NoveltyGateConfig> {
  readonly name = "NoveltyGate";
  readonly version = "0.5.0";
  private config: NoveltyGateConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<NoveltyGateConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const incoming = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (incoming.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { novel: 0, filtered: 0 } };
    }

    // Load existing memories from state store for comparison
    const existingUnits = (input.data.existingMemories ?? []) as MemoryUnit[];

    const novel: MemoryUnit[] = [];
    let filtered = 0;

    for (const unit of incoming) {
      if (unit.embedding.length === 0) {
        // No embedding — pass through (can't measure novelty)
        novel.push(unit);
        continue;
      }

      let isNovel = true;
      for (const existing of existingUnits) {
        if (existing.embedding.length === 0) continue;
        const sim = similarity(unit.embedding, existing.embedding, this.config.similarityFunction as SimilarityFunction);
        if (sim >= this.config.noveltyThreshold) {
          isNovel = false;
          break;
        }
      }

      // Also check against already-accepted novel units in this batch
      if (isNovel) {
        for (const accepted of novel) {
          if (accepted.embedding.length === 0) continue;
          const sim = similarity(unit.embedding, accepted.embedding, this.config.similarityFunction as SimilarityFunction);
          if (sim >= this.config.noveltyThreshold) {
            isNovel = false;
            break;
          }
        }
      }

      if (isNovel) {
        novel.push(unit);
      } else {
        filtered++;
      }
    }

    ctx.logger.info(
      `NoveltyGate: ${novel.length} novel, ${filtered} filtered (threshold=${this.config.noveltyThreshold})`,
    );

    return {
      data: { memoryUnits: novel },
      metrics: { novel: novel.length, filtered, total: incoming.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
