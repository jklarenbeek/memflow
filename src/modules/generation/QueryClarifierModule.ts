/**
 * QueryClarifierModule — iterative PHC-O query decomposition (PriHA)
 * Reads:  query
 * Writes: query (refined), clarifications, expandedQueries
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  maxClarificationDepth: z.number().default(2),
  maxSubQueries: z.number().default(3),
});
type Config = z.infer<typeof ConfigSchema>;

export class QueryClarifierModule implements BaseModule<Config> {
  readonly name = "QueryClarifier";
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const llm = ctx.getLLM();
    let workingQuery = query;
    let clarifications: string[] = [];
    let subQueries: string[] = [];

    if (!this.isFuzzyQuery(query)) {
      return { data: { query, clarifications: [] }, metrics: { clarified: false } };
    }

    for (let depth = 0; depth < this.config.maxClarificationDepth; depth++) {
      try {
        const { messages } = loadAndRender("priha/clarification", {
          query: workingQuery,
          context: depth === 0 ? "This is ambiguous." : "The previous decomposition needs refinement.",
          max_sub_queries: this.config.maxSubQueries,
        });
        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        clarifications = parsed.clarifications ?? [];

        if (parsed.subqueries?.length) {
          subQueries = parsed.subqueries.slice(0, this.config.maxSubQueries);
          if (subQueries.every((sq: string) => !this.isFuzzyQuery(sq))) break;
          workingQuery = subQueries[0] ?? workingQuery;
        } else break;
      } catch { break; }
    }

    if (subQueries.length > 0) workingQuery = subQueries.join(" AND ");

    ctx.logger.info(`QueryClarifier: ${clarifications.length} clarifications, ${subQueries.length} sub-queries`);
    return {
      data: { query: workingQuery, clarifications, expandedQueries: subQueries },
      metrics: { clarified: subQueries.length > 0, subQueries: subQueries.length },
    };
  }

  private isFuzzyQuery(q: string): boolean {
    return q.length < 20 || (/better|best|should|how|what if/i.test(q) && !/specific|exact|list/i.test(q));
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
