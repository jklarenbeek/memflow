/**
 * CitationInjectorModule — add inline/footnote citations with Memgraph persistence
 *
 * Enhanced to store traceable citation URLs and metadata in Memgraph as
 * :Citation nodes linked to :Answer nodes via :CITES edges.
 *
 * Reads:  finalAnswer, sources
 * Writes: finalAnswer (with citations)
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  style: z.enum(["inline", "footnote"]).default("inline"),
  maxCitations: z.number().default(6),
  /** Persist citations to Memgraph as :Citation nodes */
  persistCitations: z.boolean().default(true),
});
type Config = z.infer<typeof ConfigSchema>;

export class CitationInjectorModule implements BaseModule<Config> {
  readonly name = "CitationInjector";
  readonly version = "0.3.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    let answer = (input.data.finalAnswer as string) ?? "";
    const sources = ((input.data.sources as string[]) ?? ["internal-knowledge"]).slice(0, this.config.maxCitations);
    const answerId = (input.data as Record<string, unknown>).answerId as string | undefined;

    if (!answer.includes("[")) {
      answer = `${answer}\n\nSources: ${sources.map((s, i) => `[${i + 1}] ${s}`).join(" ")}`;
    }

    // Persist citations to Memgraph
    if (this.config.persistCitations && ctx?.memgraph) {
      await this.persistCitations(sources, answerId ?? `answer-${Date.now()}`, ctx);
    }

    return {
      data: { finalAnswer: answer, sources },
      metrics: { citations: sources.length, persisted: this.config.persistCitations },
    };
  }

  /**
   * Store citation URLs and metadata in Memgraph as :Citation nodes.
   * Links them to an :Answer node via :CITES edges for traceability.
   *
   * Uses UNWIND batch operations to reduce N+1 round-trips to 2 (Improvement #5).
   *
   * Schema:
   *   (:Answer {id})-[:CITES]->(:Citation {url, title, accessedAt, verified})
   */
  private async persistCitations(
    sources: string[],
    answerId: string,
    ctx: WorkflowContext,
  ): Promise<void> {
    try {
      // Create or match the answer node
      await ctx.memgraph.query(
        `MERGE (a:Answer {id: $answerId})
         SET a.updatedAt = $timestamp`,
        { answerId, timestamp: new Date().toISOString() },
      );

      // Batch create citation nodes and link them (Improvement #5)
      const citationItems = sources.map((source) => {
        const isUrl = /^https?:\/\//.test(source);
        return {
          url: source,
          title: isUrl
            ? source.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]
            : source,
          timestamp: new Date().toISOString(),
          verified: false,
          isUrl,
          answerId,
        };
      });

      await ctx.memgraph.batchQuery(
        `UNWIND $items AS item
         MERGE (c:Citation {url: item.url})
         SET c.title = item.title,
             c.accessedAt = item.timestamp,
             c.verified = item.verified,
             c.isUrl = item.isUrl
         WITH c, item
         MATCH (a:Answer {id: item.answerId})
         MERGE (a)-[:CITES]->(c)`,
        citationItems,
      );

      ctx.logger.debug(`CitationInjector: persisted ${sources.length} citations for answer ${answerId}`);
    } catch (err) {
      // Improvement #6: structured error logging instead of bare catch
      ctx.logger.warn(
        "CitationInjector: Memgraph persistence failed, citations still in-memory",
        { error: (err as Error).message, answerId, sourceCount: sources.length },
      );
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
