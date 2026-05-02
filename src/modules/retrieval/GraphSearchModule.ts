/**
 * GraphSearchModule — graph traversal retrieval
 *
 * === Improvement #13: Community-aware graph search ===
 * When `communityScope` is enabled and `searchScope` is "high" or
 * "exploratory", queries `:Community` node summaries for theme-based
 * retrieval without entity matching. For low-level queries, falls back
 * to the standard entity-centric graph traversal.
 *
 * Reads:  query, candidates, searchScope
 * Writes: candidates (appended)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  topK: z.number().default(8),
  weight: z.number().default(0.3),
  maxHops: z.number().default(2),
  /**
   * Improvement #13: When true, high-level queries scope traversal
   * to `:Community` nodes and their summaries. Low-level queries use
   * standard entity-centric graph traversal.
   */
  communityScope: z.boolean().default(false),
  /** Max community summaries to retrieve for high-level queries */
  maxCommunitySummaries: z.number().default(5),
});
type GraphConfig = z.infer<typeof ConfigSchema>;

export class GraphSearchModule implements BaseModule<GraphConfig> {
  readonly name = "GraphSearch";
  readonly version = "0.4.0";
  private config: GraphConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<GraphConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const existing = input.data.candidates ?? [];
    const searchScope = (input.data.searchScope as string) ?? "";

    let queryEmb: number[] = [];
    try { queryEmb = await ctx.getEmbeddings().embedQuery(query); } catch (err) {
      ctx.logger.debug("GraphSearch: embedding failed, using fallback", { error: (err as Error).message });
      queryEmb = new Array(768).fill(0.01);
    }

    // Improvement #13: Community-scoped search for high-level queries
    const isHighLevel = this.config.communityScope &&
      (searchScope === "high" || searchScope === "exploratory" || searchScope === "analytical");

    try {
      let candidates: Array<{ id: string; text: string; embedding: number[]; score: number; source: string; metadata: Record<string, unknown> }>;

      if (isHighLevel) {
        // Community-scoped retrieval: match against :Community summaries
        // for theme-based retrieval without entity matching (Improvement #13)
        const communityResults = await ctx.memgraph.query<{
          communityId: string;
          summary: string;
          nodeCount: number;
          members: string;
          score: number;
        }>(
          `MATCH (comm:Community)
           WHERE comm.summary IS NOT NULL
           WITH comm, gds.similarity.cosine(
             comm.embedding,
             $emb
           ) AS sim
           WHERE sim > 0.3
           RETURN comm.id AS communityId,
                  comm.summary AS summary,
                  comm.nodeCount AS nodeCount,
                  comm.members AS members,
                  sim AS score
           ORDER BY score DESC
           LIMIT $maxComm`,
          { emb: queryEmb, maxComm: this.config.maxCommunitySummaries },
        );

        // For each relevant community, retrieve member entities
        const communityHits: typeof candidates = [];
        for (const comm of communityResults) {
          communityHits.push({
            id: `community-${comm.communityId}`,
            text: comm.summary ?? "",
            embedding: [],
            score: comm.score * this.config.weight,
            source: "graph-community",
            metadata: {
              communityId: comm.communityId,
              nodeCount: comm.nodeCount,
              members: comm.members,
            },
          });

          // Also pull top entity chunks scoped to this community
          try {
            const memberChunks = await ctx.memgraph.query<{ node: Record<string, unknown>; score: number }>(
              `MATCH (e:Entity {communityId: $commId})<-[:MENTIONS]-(c:Chunk)
               WITH c, gds.similarity.cosine(c.embedding, $emb) AS vscore
               RETURN c AS node, vscore AS score
               ORDER BY score DESC LIMIT $k`,
              { commId: comm.communityId, emb: queryEmb, k: Math.ceil(this.config.topK / communityResults.length) },
            );

            for (const r of memberChunks) {
              communityHits.push({
                id: (r.node as any).id ?? "",
                text: (r.node as any).text ?? "",
                embedding: ((r.node as any).embedding as number[]) ?? [],
                score: r.score * this.config.weight,
                source: "graph-community",
                metadata: { ...r.node, communityId: comm.communityId },
              });
            }
          } catch {
            // Community member retrieval is best-effort
          }
        }

        candidates = communityHits;
        ctx.logger.info(
          `GraphSearch: community-scoped, ${communityResults.length} communities, ${candidates.length} total hits`,
        );
      } else {
        // Standard entity-centric graph traversal
        const results = await ctx.memgraph.query<{ node: Record<string, unknown>; score: number }>(
          `MATCH (c:Chunk)-[r:RELATES|SPATIAL_NEAR|HAS_ENTITY]->(e)
           WHERE toLower(c.text) CONTAINS toLower($q)
           WITH c, r, gds.similarity.cosine(c.embedding, $emb) AS vscore
           RETURN c AS node, (vscore * 0.6 + coalesce(r.weight, 0.4)) AS score
           ORDER BY score DESC LIMIT $k`,
          { q: query, emb: queryEmb, k: this.config.topK },
        );

        candidates = results.map((r) => ({
          id: (r.node as any).id ?? "",
          text: (r.node as any).text ?? "",
          embedding: ((r.node as any).embedding as number[]) ?? [],
          score: r.score * this.config.weight,
          source: "graph",
          metadata: r.node,
        }));

        ctx.logger.info(`GraphSearch: entity-centric, ${candidates.length} hits`);
      }

      return {
        data: { candidates: [...existing, ...candidates] },
        metrics: {
          graphHits: candidates.length,
          mode: isHighLevel ? "community" : "entity",
        },
      };
    } catch (err) {
      ctx.logger.debug("GraphSearch: not available", { error: (err as Error).message });
      return { data: { candidates: existing }, metrics: { graphHits: 0 } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
