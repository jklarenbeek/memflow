/**
 * KeywordSearchModule — fulltext keyword search with configurable BM25
 *
 * Supports two search modes (configurable via `searchMode`):
 *  - `text_search`: Basic Memgraph text index search (default)
 *  - `bm25`: MAGE BM25 scoring via text_search.search_bm25()
 *
 * Reads:  query, candidates
 * Writes: candidates (appended with source="keyword")
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  topK: z.number().default(5),
  weight: z.number().default(0.2),
  /** Search mode: "text_search" (basic) or "bm25" (MAGE BM25 extension) */
  searchMode: z.enum(["text_search", "bm25"]).default("text_search"),
  /** BM25 k1 parameter — controls term frequency saturation (only for bm25 mode) */
  bm25K1: z.number().default(1.2),
  /** BM25 b parameter — controls document length normalization (only for bm25 mode) */
  bm25B: z.number().default(0.75),
});
type KeywordConfig = z.infer<typeof ConfigSchema>;

export class KeywordSearchModule implements BaseModule<KeywordConfig> {
  readonly name = "KeywordSearch";
  readonly version = "0.3.0";
  private config: KeywordConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<KeywordConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const existing = input.data.candidates ?? [];

    try {
      const results = this.config.searchMode === "bm25"
        ? await this.searchBM25(ctx, query)
        : await this.searchTextIndex(ctx, query);

      const candidates = results.map((r) => ({
        id: (r.node as any).id ?? "", text: (r.node as any).text ?? "",
        embedding: [], score: r.score, source: "keyword", metadata: {
          ...r.node,
          searchMode: this.config.searchMode,
        },
      }));

      ctx.logger.info(`KeywordSearch (${this.config.searchMode}): ${candidates.length} hits`);
      return { data: { candidates: [...existing, ...candidates] }, metrics: { keywordHits: candidates.length, searchMode: this.config.searchMode } };
    } catch {
      ctx.logger.debug(`KeywordSearch (${this.config.searchMode}): not available`);
      return { data: { candidates: existing }, metrics: { keywordHits: 0 } };
    }
  }

  /**
   * Basic Memgraph text index search — uses built-in text_search.search().
   */
  private async searchTextIndex(
    ctx: WorkflowContext,
    query: string,
  ): Promise<Array<{ node: Record<string, unknown>; score: number }>> {
    return ctx.memgraph.query<{ node: Record<string, unknown>; score: number }>(
      `CALL text_search.search("Chunk", $query, {limit: $k}) YIELD node, score
       RETURN node, score * $kwWeight AS score`,
      { query, k: this.config.topK, kwWeight: this.config.weight },
    );
  }

  /**
   * MAGE BM25 search — uses text_search.search_bm25() with configurable
   * k1 (term frequency saturation) and b (length normalization) parameters.
   *
   * Falls back to basic text_search if BM25 procedure is unavailable.
   */
  private async searchBM25(
    ctx: WorkflowContext,
    query: string,
  ): Promise<Array<{ node: Record<string, unknown>; score: number }>> {
    try {
      return await ctx.memgraph.query<{ node: Record<string, unknown>; score: number }>(
        `CALL text_search.search_bm25("Chunk", $query, {limit: $k, k1: $k1, b: $b}) YIELD node, score
         RETURN node, score * $kwWeight AS score`,
        { query, k: this.config.topK, kwWeight: this.config.weight, k1: this.config.bm25K1, b: this.config.bm25B },
      );
    } catch {
      // Fallback to basic text_search if BM25 is not available
      ctx.logger.debug("KeywordSearch: BM25 not available, falling back to text_search");
      return this.searchTextIndex(ctx, query);
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
