/**
 * GraphSearchModule — graph traversal retrieval
 *
 * Reads:  query, candidates
 * Writes: candidates (appended)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({ topK: z.number().default(8), weight: z.number().default(0.3) });
type GraphConfig = z.infer<typeof ConfigSchema>;

export class GraphSearchModule implements BaseModule<GraphConfig> {
  readonly name = "GraphSearch";
  readonly version = "0.2.0";
  private config: GraphConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<GraphConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const existing = (input.data.candidates ?? []) as Array<Record<string, unknown>>;

    let queryEmb: number[] = [];
    try { queryEmb = await ctx.getEmbeddings().embedQuery(query); } catch { queryEmb = new Array(768).fill(0.01); }

    try {
      const results = await ctx.memgraph.query<{ node: Record<string, unknown>; score: number }>(
        `MATCH (c:Chunk)-[r:RELATES|SPATIAL_NEAR|HAS_ENTITY]->(e)
         WHERE toLower(c.text) CONTAINS toLower($q)
         WITH c, r, gds.similarity.cosine(c.embedding, $emb) AS vscore
         RETURN c AS node, (vscore * 0.6 + coalesce(r.weight, 0.4)) AS score
         ORDER BY score DESC LIMIT $k`,
        { q: query, emb: queryEmb, k: this.config.topK },
      );

      const candidates = results.map((r) => ({
        id: (r.node as any).id ?? "", text: (r.node as any).text ?? "",
        embedding: ((r.node as any).embedding as number[]) ?? [],
        score: r.score * this.config.weight, source: "graph", metadata: r.node,
      }));

      ctx.logger.info(`GraphSearch: ${candidates.length} hits`);
      return { data: { candidates: [...existing, ...candidates] }, metrics: { hits: candidates.length } };
    } catch {
      ctx.logger.debug("GraphSearch: not available");
      return { data: { candidates: existing }, metrics: { hits: 0 } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
