/**
 * VectorSearchModule — Memgraph vector similarity search
 *
 * Reads:  query, embeddings
 * Writes: candidates (appended)
 */

import { z } from "zod";
import neo4j from "neo4j-driver";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  topK: z.number().default(10),
  minScore: z.number().default(0.6),
  weight: z.number().default(0.5),
});
type VectorConfig = z.infer<typeof ConfigSchema>;

export class VectorSearchModule implements BaseModule<VectorConfig> {
  readonly name = "VectorSearch";
  readonly version = "0.2.0";
  private config: VectorConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<VectorConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const existing = input.data.candidates ?? [];

    let queryEmb: number[] = [];
    try {
      queryEmb = await ctx.getEmbeddings().embedQuery(query);
    } catch {
      queryEmb = new Array(768).fill(0.01);
    }

    try {
      const results = await ctx.memgraph.vectorSearch(queryEmb, "Chunk", "embedding", this.config.topK, this.config.minScore);
      const candidates = results.map((r) => ({
        id: (r.node as any).id ?? "",
        text: (r.node as any).text ?? (r.node as any).content ?? "",
        embedding: ((r.node as any).embedding as number[]) ?? [],
        score: r.score * this.config.weight,
        source: "vector",
        metadata: r.node,
      }));

      ctx.logger.info(`VectorSearch: ${candidates.length} hits`);
      return { data: { candidates: [...existing, ...candidates] }, metrics: { vectorHits: candidates.length } };
    } catch {
      ctx.logger.debug("VectorSearch: not available");
      return { data: { candidates: existing }, metrics: { vectorHits: 0 } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
