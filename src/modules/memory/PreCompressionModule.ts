/**
 * PreCompressionModule — LightMem §3.1 Pre-Compressing Submodule
 *
 * Eliminates redundant tokens before topic segmentation, implementing the
 * paper's LLM-based cross-entropy filtering approach:
 *
 *   x̂ = {xᵢ ∈ x | P(retain xᵢ | x; θ) > τ},  τ = Percentile({xⱼ}, r)
 *
 * Since MemFlow doesn't bundle LLMLingua-2 (a Python model), this uses
 * the paper's alternative: LLM-based density scoring per sentence.
 * "Tokens with higher conditional entropy under a given context are more
 *  uncertain and less predictable, indicating greater informational
 *  uniqueness and a more critical role in semantic expression."
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — compressed, redundancy removed
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
  /** Compression ratio r — retain this fraction of input (0.0–1.0) */
  compressionRatio: z.number().min(0.1).max(0.9).default(0.5),
  /** Maximum input tokens to process per unit */
  maxInputTokens: z.number().default(4000),
  /** Use LLM for density scoring (falls back to heuristic) */
  useLLM: z.boolean().default(true),
  /** Minimum sentence length to consider (chars) */
  minSentenceLength: z.number().default(10),
});

type PreCompressionConfig = z.infer<typeof ConfigSchema>;

export class PreCompressionModule implements BaseModule<PreCompressionConfig> {
  readonly name = "PreCompression";
  readonly version = "0.2.0";
  private config: PreCompressionConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<PreCompressionConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { compressed: 0 } };
    }

    let totalOriginal = 0;
    let totalCompressed = 0;

    const compressed: MemoryUnit[] = [];

    for (const unit of units) {
      const original = unit.content;
      totalOriginal += original.length;

      const compressedContent = this.config.useLLM
        ? await this.llmCompress(original, ctx)
        : this.heuristicCompress(original);

      totalCompressed += compressedContent.length;

      compressed.push({
        ...unit,
        content: compressedContent,
        metadata: {
          ...unit.metadata,
          preCompressed: true,
          originalLength: original.length,
          compressedLength: compressedContent.length,
          compressionRatio: original.length > 0
            ? compressedContent.length / original.length
            : 1,
        },
      });
    }

    const ratio = totalOriginal > 0 ? totalCompressed / totalOriginal : 1;
    ctx.logger.info(
      `PreCompression: ${units.length} units, ` +
        `${totalOriginal} → ${totalCompressed} chars (${(ratio * 100).toFixed(1)}% retained)`,
    );

    return {
      data: { memoryUnits: compressed },
      metrics: {
        compressed: units.length,
        originalChars: totalOriginal,
        compressedChars: totalCompressed,
        retentionRate: Math.round(ratio * 100),
      },
    };
  }

  /**
   * LLM-based compression: score each sentence's information density,
   * then retain sentences above the r-th percentile threshold.
   */
  private async llmCompress(
    text: string,
    ctx: WorkflowContext,
  ): Promise<string> {
    const sentences = this.splitSentences(text);
    if (sentences.length <= 1) return text;

    try {
      const llm = ctx.getLLM();
      const truncated = text.substring(0, this.config.maxInputTokens * 4);

      const { messages } = loadAndRender("lightmem/pre_compression", {
        content: truncated,
        sentence_count: sentences.length,
      });

      const resp = await llm.invoke(messages);
      const content = typeof resp.content === "string" ? resp.content : "";

      // Parse scored sentences — expect JSON array of { sentence, score }
      const parsed = JSON.parse(
        content.match(/\[[\s\S]*\]/)?.[0] ?? "[]",
      ) as Array<{ sentence?: string; score?: number; index?: number }>;

      if (parsed.length === 0) return this.heuristicCompress(text);

      // Apply dynamic percentile threshold τ = Percentile(scores, r)
      const scores = parsed
        .map((p) => p.score ?? 0.5)
        .sort((a, b) => a - b);
      const percentileIdx = Math.floor(
        scores.length * (1 - this.config.compressionRatio),
      );
      const threshold = scores[Math.min(percentileIdx, scores.length - 1)];

      // Retain sentences above threshold
      const retained = parsed
        .filter((p) => (p.score ?? 0.5) >= threshold)
        .map((p) => p.sentence ?? "")
        .filter((s) => s.trim().length > 0);

      return retained.length > 0 ? retained.join(" ") : this.heuristicCompress(text);
    } catch {
      return this.heuristicCompress(text);
    }
  }

  /**
   * Heuristic fallback: retain sentences with above-average word count
   * and discard filler/greeting patterns.
   */
  private heuristicCompress(text: string): string {
    const sentences = this.splitSentences(text);
    if (sentences.length <= 2) return text;

    const wordCounts = sentences.map(
      (s) => s.split(/\s+/).filter((w) => w.length > 2).length,
    );
    const avgWords =
      wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;

    // Filter out filler patterns (greetings, pleasantries, short acks)
    const fillerPattern =
      /^(hey|hi|hello|thanks|thank you|ok|okay|sure|yes|no|bye|goodbye|great|nice|wow|cool|right|hm+|ah+|oh+|well)\b/i;

    const retained: string[] = [];
    const targetCount = Math.ceil(sentences.length * this.config.compressionRatio);

    // Score and rank
    const scored = sentences
      .map((s, i) => ({
        sentence: s,
        score: fillerPattern.test(s.trim()) ? 0 : wordCounts[i] / Math.max(1, avgWords),
      }))
      .sort((a, b) => b.score - a.score);

    // Take top r% by score, then re-sort by original order
    const topSentences = new Set(
      scored.slice(0, targetCount).map((s) => s.sentence),
    );

    for (const s of sentences) {
      if (topSentences.has(s)) retained.push(s);
    }

    return retained.join(" ");
  }

  private splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+|[\n\r]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= this.config.minSentenceLength);
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
