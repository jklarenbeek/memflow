/**
 * AttentionScoreModule — LLM-based attention boundary approximation
 *
 * Provides an alternative B1 signal for TopicSegmenterModule.
 * The LightMem paper (§3.2) specifies LLMLingua-2 attention scores
 * for topic boundary detection, but LLMLingua-2 is Python-only.
 *
 * This module approximates that capability by asking the LLM to score
 * each sentence boundary's semantic shift on a 0–1 scale, producing
 * `attentionBoundaryScore` metadata on each MemoryUnit.
 *
 * TopicSegmenter can use these scores as its B1 signal (when configured
 * with `b1Source: "attention"`) instead of the default cosine-similarity
 * based local minima detection.
 *
 * Pipeline position: inserted BEFORE TopicSegmenter in lightmem-pipeline.
 * Only activated when b1Source === "attention" (opt-in).
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[] — with metadata.attentionBoundaryScore)
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Number of sentences to process per LLM batch */
  batchSize: z.number().default(20),
  /** Minimum score to be considered a potential boundary */
  boundaryMinScore: z.number().min(0).max(1).default(0.5),
});

type AttentionScoreConfig = z.infer<typeof ConfigSchema>;

export class AttentionScoreModule implements BaseModule<AttentionScoreConfig> {
  readonly name = "AttentionScore";
  readonly version = "0.1.0";
  private config: AttentionScoreConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<AttentionScoreConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length <= 1) {
      return { data: { memoryUnits: units }, metrics: { scored: 0 } };
    }

    // Build sentence pairs for boundary scoring
    const pairs: Array<{ idx: number; before: string; after: string }> = [];
    for (let i = 0; i < units.length - 1; i++) {
      pairs.push({
        idx: i,
        before: units[i].content.substring(0, 200),
        after: units[i + 1].content.substring(0, 200),
      });
    }

    // Process in batches
    let scored = 0;
    for (let batchStart = 0; batchStart < pairs.length; batchStart += this.config.batchSize) {
      const batch = pairs.slice(batchStart, batchStart + this.config.batchSize);

      try {
        const scores = await this.scoreBatch(batch, ctx);
        for (let j = 0; j < scores.length; j++) {
          const pairIdx = batch[j].idx;
          units[pairIdx].metadata = {
            ...units[pairIdx].metadata,
            attentionBoundaryScore: scores[j],
          };
          scored++;
        }
      } catch {
        // If LLM scoring fails, mark with neutral score
        for (const pair of batch) {
          units[pair.idx].metadata = {
            ...units[pair.idx].metadata,
            attentionBoundaryScore: 0.5,
          };
        }
      }
    }

    ctx.logger.info(`AttentionScore: scored ${scored} boundaries out of ${pairs.length}`);

    return {
      data: { memoryUnits: units },
      metrics: { scored, total: pairs.length },
    };
  }

  /**
   * Ask the LLM to score semantic shift at each boundary.
   * Returns scores between 0 (no shift) and 1 (major topic change).
   */
  private async scoreBatch(
    pairs: Array<{ idx: number; before: string; after: string }>,
    ctx: WorkflowContext,
  ): Promise<number[]> {
    const llm = ctx.getLLM();

    const pairText = pairs
      .map(
        (p, i) =>
          `[Boundary ${i + 1}]\nBEFORE: "${p.before}"\nAFTER: "${p.after}"`,
      )
      .join("\n\n");

    const resp = await llm.invoke([
      {
        role: "system",
        content: `You are a semantic boundary detector. For each pair of adjacent text passages, score the semantic shift at the boundary on a scale of 0.0 to 1.0:
- 0.0 = Same topic, no shift
- 0.3 = Minor topic drift
- 0.6 = Significant topic change
- 1.0 = Complete topic change

Respond with ONLY a JSON array of numbers, one per boundary. Example: [0.2, 0.8, 0.1]`,
      },
      {
        role: "user",
        content: `Score the semantic shift at each boundary:\n\n${pairText}`,
      },
    ]);

    const text = typeof resp.content === "string" ? resp.content : "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) {
      return pairs.map(() => 0.5);
    }

    const parsed = JSON.parse(match[0]) as number[];
    // Ensure correct length and valid range
    return pairs.map((_, i) => {
      const score = parsed[i] ?? 0.5;
      return Math.max(0, Math.min(1, score));
    });
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
