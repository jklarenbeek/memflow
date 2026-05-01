/**
 * SemanticSynthesisModule — merge highly similar memory units
 *
 * Extracted from SimpleMem online synthesis. Identifies pairs of
 * memory units with cosine similarity above a threshold and merges
 * them into consolidated entries, reducing redundancy.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — deduplicated/merged
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";

const ConfigSchema = z.object({
  /** Cosine similarity threshold for merging (strictly greater than) */
  synthesisThreshold: z.number().min(0).max(1).default(0.82),
});

type SemanticSynthesisConfig = z.infer<typeof ConfigSchema>;

export class SemanticSynthesisModule implements BaseModule<SemanticSynthesisConfig> {
  readonly name = "SemanticSynthesis";
  readonly version = "0.2.0";
  private config: SemanticSynthesisConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SemanticSynthesisConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = [...((input.data.memoryUnits ?? []) as MemoryUnit[])];

    if (units.length <= 1) {
      return { data: { memoryUnits: units }, metrics: { merged: 0 } };
    }

    const merged = new Set<number>();
    let mergeCount = 0;

    for (let i = 0; i < units.length; i++) {
      if (merged.has(i) || units[i].embedding.length === 0) continue;

      for (let j = i + 1; j < units.length; j++) {
        if (merged.has(j) || units[j].embedding.length === 0) continue;

        const sim = cosineSimilarity(units[i].embedding, units[j].embedding);
        if (sim > this.config.synthesisThreshold) {
          // Merge j into i: combine content, average embeddings
          units[i] = {
            ...units[i],
            content: `${units[i].content}\n${units[j].content}`,
            embedding: units[i].embedding.map(
              (v, idx) => (v + (units[j].embedding[idx] ?? 0)) / 2,
            ),
            metadata: {
              ...units[i].metadata,
              synthesized: true,
              mergedFrom: [
                ...((units[i].metadata.mergedFrom as string[]) ?? []),
                units[j].id,
              ],
              confidence: Math.max(
                (units[i].metadata.confidence as number) ?? 0.7,
                (units[j].metadata.confidence as number) ?? 0.7,
              ),
            },
          };
          merged.add(j);
          mergeCount++;
        }
      }
    }

    const result = units.filter((_, i) => !merged.has(i));

    ctx.logger.info(
      `SemanticSynthesis: Merged ${mergeCount} pairs, ${units.length} → ${result.length} units`,
    );

    return {
      data: { memoryUnits: result },
      metrics: { merged: mergeCount, before: units.length, after: result.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
