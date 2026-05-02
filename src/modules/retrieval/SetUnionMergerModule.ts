/**
 * SetUnionMergerModule — OMNI-SIMPLEMEM §4.2 Set-Union Merging
 *
 * Alternative to score-based fusion (ResultRanker). The OMNI-SIMPLEMEM
 * paper discovers that set-union merging of retrieval results from
 * multiple channels (FAISS + BM25 / semantic + lexical + symbolic)
 * outperforms weighted score fusion.
 *
 * Instead of computing weighted scores across channels and ranking,
 * this module takes the union of all candidate sets, deduplicates by
 * content/ID, and preserves all unique results.
 *
 * Can be used as a drop-in replacement for ResultRanker in any
 * retrieval sub-workflow.
 *
 * Reads:  candidates (from multiple search channels)
 * Writes: candidates (deduplicated set-union), retrievalResult
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
  /** Maximum total candidates after union */
  maxCandidates: z.number().default(30),
  /** Token budget for final context */
  tokenBudget: z.number().default(4000),
  /** Chars per token approximation */
  charsPerToken: z.number().default(4),
});
type SetUnionConfig = z.infer<typeof ConfigSchema>;

interface Candidate {
  id: string;
  text: string;
  embedding: number[];
  score: number;
  source: string;
  metadata: Record<string, unknown>;
}

export class SetUnionMergerModule implements BaseModule<SetUnionConfig> {
  readonly name = "SetUnionMerger";
  readonly version = "0.5.0";
  private config: SetUnionConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<SetUnionConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const candidates = (input.data.candidates ?? []) as Candidate[];

    if (candidates.length === 0) {
      return {
        data: { candidates: [], retrievalResult: { chunks: [], memories: [], graphPaths: [], score: 0, sources: [] } },
        metrics: { unionSize: 0 },
      };
    }

    // Set-union: deduplicate by ID, keeping the highest-scoring entry per ID
    const seen = new Map<string, Candidate>();
    for (const c of candidates) {
      const key = c.id || c.text.substring(0, 100);
      const existing = seen.get(key);
      if (!existing || c.score > existing.score) {
        seen.set(key, c);
      }
    }

    // Collect unique candidates, sorted by score descending
    let unified = [...seen.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxCandidates);

    // Apply token budget gating
    let tokenCount = 0;
    const budgetCapped: Candidate[] = [];
    for (const c of unified) {
      const tokens = Math.ceil(c.text.length / this.config.charsPerToken);
      if (tokenCount + tokens > this.config.tokenBudget) break;
      tokenCount += tokens;
      budgetCapped.push(c);
    }
    unified = budgetCapped;

    // Build retrieval result
    const sources = [...new Set(unified.map((c) => c.source))];

    ctx.logger.info(
      `SetUnionMerger: ${candidates.length} → ${unified.length} candidates ` +
        `(${sources.length} channels: ${sources.join(", ")})`,
    );

    return {
      data: {
        candidates: unified,
        retrievalResult: {
          chunks: unified.map((c) => ({
            pageContent: c.text,
            metadata: { ...c.metadata, score: c.score, source: c.source },
          })),
          memories: [],
          graphPaths: [],
          score: unified.length > 0 ? unified[0].score : 0,
          sources,
        },
      },
      metrics: {
        inputCandidates: candidates.length,
        unionSize: unified.length,
        channels: sources.length,
        tokenCount,
      },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
