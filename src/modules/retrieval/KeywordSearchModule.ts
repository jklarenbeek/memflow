/**
 * KeywordSearchModule — fulltext keyword search
 *
 * Reads:  query, candidates
 * Writes: candidates (appended)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({ topK: z.number().default(5), weight: z.number().default(0.2) });
type KeywordConfig = z.infer<typeof ConfigSchema>;

export class KeywordSearchModule implements BaseModule<KeywordConfig> {
  readonly name = "KeywordSearch";
  readonly version = "0.2.0";
  private config: KeywordConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<KeywordConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const existing = (input.data.candidates ?? []) as Array<Record<string, unknown>>;

    try {
      const results = await ctx.memgraph.query<{ node: Record<string, unknown>; score: number }>(
        `CALL text_search.search("Chunk", $query, {limit: $k}) YIELD node, score
         RETURN node, score * $kwWeight AS score`,
        { query, k: this.config.topK, kwWeight: this.config.weight },
      );

      const candidates = results.map((r) => ({
        id: (r.node as any).id ?? "", text: (r.node as any).text ?? "",
        embedding: [], score: r.score, source: "keyword", metadata: r.node,
      }));

      ctx.logger.info(`KeywordSearch: ${candidates.length} hits`);
      return { data: { candidates: [...existing, ...candidates] }, metrics: { hits: candidates.length } };
    } catch {
      ctx.logger.debug("KeywordSearch: not available");
      return { data: { candidates: existing }, metrics: { hits: 0 } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
