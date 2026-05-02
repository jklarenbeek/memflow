/**
 * ResultRankerModule — dedup, rank, and assemble RetrievalResult
 *
 * Reads:  query, candidates
 * Writes: retrievalResult (RetrievalResult)
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type { BaseModule, ModuleInput, ModuleOutput, RetrievalResult, MemoryUnit } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { estimateTokens } from "../../utils/tokens.js";

const ConfigSchema = z.object({
  topK: z.number().default(8),
  tokenBudget: z.number().default(4000),
  usePyramid: z.boolean().default(true),
});
type RankerConfig = z.infer<typeof ConfigSchema>;

interface ScoredCandidate {
  id: string; text: string; embedding: number[]; score: number; source: string; metadata: Record<string, unknown>;
}

export class ResultRankerModule implements BaseModule<RankerConfig> {
  readonly name = "ResultRanker";
  readonly version = "0.5.0";
  private config: RankerConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<RankerConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const candidates = (input.data.candidates ?? []) as ScoredCandidate[];

    // Dedup
    const seen = new Set<string>();
    const deduped = candidates.filter((c) => {
      const key = c.id || c.text.substring(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.score - a.score);

    // Pyramid expansion: budget-gated selection
    let finalChunks: Document[];
    if (this.config.usePyramid) {
      let used = 0;
      finalChunks = [];
      for (const c of deduped) {
        const tokens = estimateTokens(c.text);
        if (used + tokens > this.config.tokenBudget) break;
        finalChunks.push(new Document({ pageContent: c.text, metadata: { id: c.id, score: c.score, source: c.source, ...c.metadata } }));
        used += tokens;
      }
    } else {
      finalChunks = deduped.slice(0, this.config.topK).map((c) =>
        new Document({ pageContent: c.text, metadata: { id: c.id, score: c.score, source: c.source, ...c.metadata } }),
      );
    }

    // Also retrieve related memory units
    let memories: MemoryUnit[] = [];
    try {
      const query = (input.data.query as string) ?? "";
      const queryEmb = await ctx.getEmbeddings().embedQuery(query);
      const memResults = await ctx.memgraph.vectorSearch(queryEmb, "MemoryUnit", "embedding", 5, 0.65);
      memories = memResults.map((r) => ({
        id: (r.node as any).id ?? "", content: (r.node as any).content ?? "",
        embedding: ((r.node as any).embedding as number[]) ?? [],
        timestamp: new Date((r.node as any).timestamp ?? Date.now()),
        type: ((r.node as any).type as MemoryUnit["type"]) ?? "fact", metadata: {},
      }));
    } catch { /* memory search optional */ }

    const avgScore = finalChunks.length > 0
      ? finalChunks.reduce((s, c) => s + ((c.metadata?.score as number) ?? 0.5), 0) / finalChunks.length
      : 0.3;

    const result: RetrievalResult = {
      chunks: finalChunks, memories,
      graphPaths: candidates.filter((c) => c.source === "graph"),
      score: avgScore,
      sources: [...new Set(finalChunks.map((c) => (c.metadata?.source as string) ?? "unknown"))],
    };

    ctx.logger.info(`ResultRanker: ${finalChunks.length} chunks, avg score ${avgScore.toFixed(3)}`);

    return {
      data: { retrievalResult: result, graphContext: finalChunks.map((c) => c.pageContent).join("\n\n") },
      metrics: { finalChunks: finalChunks.length, avgScore: Number(avgScore.toFixed(3)) },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
