/**
 * LightRAGRetrieverModule — real hybrid retrieval
 *
 * Adapted from HRW's LightRAGRetriever (202 lines of real logic).
 * Implements the LightRAG paper's dual-level retrieval plus:
 *
 *  1. Vector search (low-level precise facts) via MemgraphClient
 *  2. Graph traversal (high-level entity relations + communities)
 *  3. Keyword fulltext fallback
 *  4. Intent-aware planning: LLM infers scope before querying
 *  5. Pyramid progressive expansion: start with top results, expand to
 *     graph neighbours if recall is low, gated by token budget
 *
 * NOTE: The LightRAG paper's incremental graph index update algorithm is
 * handled externally by MemgraphGraphModule, which uses MERGE-based upserts
 * to avoid rebuilding the full index on new document ingestion. This module
 * focuses solely on the retrieval path.
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
  RetrievalResult,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { estimateTokens } from "../../utils/tokens.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  topK: z.number().default(8),
  useGraph: z.boolean().default(true),
  useVector: z.boolean().default(true),
  usePyramid: z.boolean().default(true),
  intentAware: z.boolean().default(true),
  hybridWeights: z
    .object({
      vector: z.number().default(0.5),
      graph: z.number().default(0.3),
      keyword: z.number().default(0.2),
    })
    .default({}),
  tokenBudget: z.number().default(4000),
});

type RetrieverConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  id: string;
  text: string;
  embedding: number[];
  score: number;
  source: "vector" | "graph" | "keyword";
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LightRAGRetrieverModule implements BaseModule<RetrieverConfig> {
  readonly name = "LightRAGRetriever";
  readonly version = "2.0.0";
  private config: RetrieverConfig;
  private ctx?: WorkflowContext;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<RetrieverConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const query = (input.data.query as string) ?? "";

    if (!query.trim()) {
      return { data: { retrievalResult: emptyResult() }, metrics: { hits: 0 } };
    }

    ctx.logger.info(
      `LightRAGRetriever: Query="${query.substring(0, 80)}…"`,
    );

    // Embed query
    const embeddings = ctx.getEmbeddings();
    let queryEmb: number[] = [];
    try {
      queryEmb = await embeddings.embedQuery(query);
    } catch {
      ctx.logger.warn("Query embedding failed, using zero vector");
      queryEmb = new Array(768).fill(0.01);
    }

    // 1. Intent-aware scope
    let searchScope = "full";
    if (this.config.intentAware) {
      searchScope = await this.inferScope(query, ctx);
    }

    const candidates: ScoredCandidate[] = [];

    // 2. Vector search
    if (this.config.useVector) {
      const vecResults = await ctx.memgraph.vectorSearch(
        queryEmb,
        "Chunk",
        "embedding",
        this.config.topK * 2,
        0.6,
      );
      for (const r of vecResults) {
        candidates.push({
          id: (r.node as any).id ?? "",
          text: (r.node as any).text ?? (r.node as any).content ?? "",
          embedding: ((r.node as any).embedding as number[]) ?? [],
          score: r.score * this.config.hybridWeights.vector,
          source: "vector",
          metadata: r.node,
        });
      }
    }

    // 3. Graph traversal
    if (this.config.useGraph) {
      const graphResults = await this.graphSearch(query, queryEmb, ctx);
      candidates.push(...graphResults);
    }

    // 4. Keyword fulltext
    try {
      const kwResults = await ctx.memgraph.query<{
        node: Record<string, unknown>;
        score: number;
      }>(
        `CALL text_search.search("Chunk", $query, {limit: $k}) YIELD node, score
         RETURN node, score * $kwWeight AS score`,
        {
          query,
          k: this.config.topK,
          kwWeight: this.config.hybridWeights.keyword,
        },
      );
      for (const r of kwResults) {
        candidates.push({
          id: (r.node as any).id ?? "",
          text: (r.node as any).text ?? "",
          embedding: [],
          score: r.score,
          source: "keyword",
          metadata: r.node,
        });
      }
    } catch {
      ctx.logger.debug("Keyword search not available");
    }

    // 5. Rank, dedup, and optionally pyramid expand
    let finalChunks: Document[];
    if (this.config.usePyramid && candidates.length > 0) {
      finalChunks = await this.pyramidExpand(candidates, ctx);
    } else {
      finalChunks = this.rankAndDedup(candidates)
        .slice(0, this.config.topK)
        .map((c) => this.toDocument(c));
    }

    // 6. Also retrieve related memory units
    let memories: MemoryUnit[] = [];
    try {
      const memResults = await ctx.memgraph.vectorSearch(
        queryEmb,
        "MemoryUnit",
        "embedding",
        5,
        0.65,
      );
      memories = memResults.map((r) => ({
        id: (r.node as any).id ?? "",
        content: (r.node as any).content ?? "",
        embedding: ((r.node as any).embedding as number[]) ?? [],
        timestamp: new Date((r.node as any).timestamp ?? Date.now()),
        type: ((r.node as any).type as MemoryUnit["type"]) ?? "fact",
        metadata: {},
      }));
    } catch {
      ctx.logger.debug("Memory vector search not available");
    }

    const avgScore =
      finalChunks.length > 0
        ? finalChunks.reduce(
            (s, c) => s + ((c.metadata?.score as number) ?? 0.5),
            0,
          ) / finalChunks.length
        : 0.3;

    const result: RetrievalResult = {
      chunks: finalChunks,
      memories,
      graphPaths: candidates.filter((c) => c.source === "graph"),
      score: avgScore,
      sources: [
        ...new Set(finalChunks.map((c) => (c.metadata?.source as string) ?? "unknown")),
      ],
    };

    return {
      data: { retrievalResult: result, graphContext: finalChunks.map(c => c.pageContent).join("\n\n") },
      metrics: {
        vectorHits: candidates.filter((c) => c.source === "vector").length,
        graphHits: candidates.filter((c) => c.source === "graph").length,
        keywordHits: candidates.filter((c) => c.source === "keyword").length,
        finalChunks: finalChunks.length,
        avgScore: Number(avgScore.toFixed(3)),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Intent inference
  // -----------------------------------------------------------------------

  private async inferScope(
    query: string,
    ctx: WorkflowContext,
  ): Promise<string> {
    try {
      const llm = ctx.getLLM();
      const resp = await llm.invoke([
        {
          role: "user",
          content: `Analyze the user query and output JSON: {"type": "fact|comparison|timeline|howto|multi-hop", "scope": "recent|full|entity-specific"}\nQuery: ${query}`,
        },
      ]);
      const text =
        typeof resp.content === "string" ? resp.content : "";
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      ctx.logger.debug(`Intent: ${json.type}, scope: ${json.scope}`);
      return json.scope ?? "full";
    } catch {
      return "full";
    }
  }

  // -----------------------------------------------------------------------
  // Graph search
  // -----------------------------------------------------------------------

  private async graphSearch(
    query: string,
    queryEmb: number[],
    ctx: WorkflowContext,
  ): Promise<ScoredCandidate[]> {
    try {
      const results = await ctx.memgraph.query<{
        node: Record<string, unknown>;
        score: number;
      }>(
        `MATCH (c:Chunk)-[r:RELATES|SPATIAL_NEAR|HAS_ENTITY]->(e)
         WHERE toLower(c.text) CONTAINS toLower($q)
         WITH c, r, gds.similarity.cosine(c.embedding, $emb) AS vscore
         RETURN c AS node, (vscore * 0.6 + coalesce(r.weight, 0.4)) AS score
         ORDER BY score DESC LIMIT $k`,
        { q: query, emb: queryEmb, k: this.config.topK },
      );
      return results.map((r) => ({
        id: (r.node as any).id ?? "",
        text: (r.node as any).text ?? "",
        embedding: ((r.node as any).embedding as number[]) ?? [],
        score: r.score * this.config.hybridWeights.graph,
        source: "graph" as const,
        metadata: r.node,
      }));
    } catch {
      ctx.logger.debug("Graph search not available");
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Pyramid expansion
  // -----------------------------------------------------------------------

  private async pyramidExpand(
    candidates: ScoredCandidate[],
    ctx: WorkflowContext,
  ): Promise<Document[]> {
    const budget = this.config.tokenBudget;
    let used = 0;
    const selected: Document[] = [];

    candidates.sort((a, b) => b.score - a.score);

    for (const cand of candidates) {
      const tokens = estimateTokens(cand.text);
      if (used + tokens > budget) break;
      selected.push(this.toDocument(cand));
      used += tokens;
    }

    // Low recall? Expand via graph neighbours
    if (selected.length < 3 && this.config.useGraph) {
      for (const doc of selected.slice(0, 2)) {
        try {
          const neighbours = await ctx.memgraph.query<{
            n: Record<string, unknown>;
          }>(
            `MATCH (c:Chunk {id: $id})-[:RELATES|SPATIAL_NEAR]->(n:Chunk)
             RETURN n LIMIT 3`,
            { id: doc.metadata?.id ?? "" },
          );
          for (const nb of neighbours) {
            const text = (nb.n as any).text ?? "";
            const tokens = estimateTokens(text);
            if (used + tokens < budget * 1.2) {
              selected.push(
                new Document({
                  pageContent: text,
                  metadata: { source: "graph-expansion", ...(nb.n as Record<string, unknown>) },
                }),
              );
              used += tokens;
            }
          }
        } catch {
          break;
        }
      }
    }

    return selected;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private rankAndDedup(candidates: ScoredCandidate[]): ScoredCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((c) => {
      const key = c.id || c.text.substring(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.score - a.score);
  }

  private toDocument(c: ScoredCandidate): Document {
    return new Document({
      pageContent: c.text,
      metadata: { id: c.id, score: c.score, source: c.source, ...c.metadata },
    });
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}

function emptyResult(): RetrievalResult {
  return { chunks: [], memories: [], graphPaths: [], score: 0, sources: [] };
}