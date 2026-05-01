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

      // Create citation nodes and link them
      for (const source of sources) {
        const isUrl = /^https?:\/\//.test(source);
        const title = isUrl
          ? source.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]
          : source;

        await ctx.memgraph.query(
          `MERGE (c:Citation {url: $url})
           SET c.title = $title,
               c.accessedAt = $timestamp,
               c.verified = $verified,
               c.isUrl = $isUrl
           WITH c
           MATCH (a:Answer {id: $answerId})
           MERGE (a)-[:CITES]->(c)`,
          {
            url: source,
            title,
            timestamp: new Date().toISOString(),
            verified: false,
            isUrl,
            answerId,
          },
        );
      }

      ctx.logger.debug(`CitationInjector: persisted ${sources.length} citations for answer ${answerId}`);
    } catch {
      ctx.logger.debug("CitationInjector: Memgraph persistence failed, citations still in-memory");
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
