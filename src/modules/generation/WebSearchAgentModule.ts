/**
 * WebSearchAgentModule — PriHA §3.3 Web Search Agent
 *
 * Implements dual retrieval (local KB + live web) via Tavily search:
 *  1. Receive optimized query from PHC-O (QueryClarifier)
 *  2. Execute web search via Tavily API
 *  3. Validate result URLs against safelist regex
 *  4. Rerank results using LLM relevance scoring
 *  5. Return structured web context (Cweb) with traceable URLs
 *
 * Reads:  query, expandedQueries
 * Writes: webContext (string), webSources (string[]), webSearchCompleted (boolean)
 */

import { z } from "zod";
import { tavily, type TavilySearchResponse } from "@tavily/core";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Maximum number of web search results to process */
  maxResults: z.number().default(5),
  /** Search API provider */
  searchProvider: z.enum(["tavily", "none"]).default("none"),
  /** Tavily API key (falls back to TAVILY_API_KEY env var) */
  apiKey: z.string().optional(),
  /** URL safelist pattern (regex) for allowed domains */
  urlSafelist: z.string().default(".*"),
  /** Search depth: basic or advanced */
  searchDepth: z.enum(["basic", "advanced"]).default("basic"),
  /** Include answer summary from Tavily */
  includeAnswer: z.boolean().default(true),
  /** Maximum number of query expansions to search */
  maxQueryExpansions: z.number().default(3),
});

type WebSearchConfig = z.infer<typeof ConfigSchema>;

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export class WebSearchAgentModule implements BaseModule<WebSearchConfig> {
  readonly name = "WebSearchAgent";
  readonly version = "0.5.0";
  private config: WebSearchConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<WebSearchConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    if (this.config.searchProvider === "none") {
      ctx.logger.info("WebSearchAgent: searchProvider is 'none', skipping web search");
      return {
        data: { webContext: "", webSources: [], webSearchCompleted: false },
        metrics: { webSearchQueries: 0, webSearchEnabled: false },
      };
    }

    const query = (input.data.query as string) ?? "";
    const expanded = (input.data.expandedQueries as string[]) ?? [query];
    const queries = expanded.length > 0 ? expanded : [query];

    let allResults: SearchResult[] = [];
    let queriesIssued = 0;
    let urlsCrawled = 0;

    try {
      const apiKey = this.config.apiKey ?? process.env.TAVILY_API_KEY;
      if (!apiKey) {
        ctx.logger.warn("WebSearchAgent: No Tavily API key configured");
        return {
          data: { webContext: "", webSources: [], webSearchCompleted: false },
          metrics: { webSearchQueries: 0, webSearchEnabled: true, error: 1 },
        };
      }

      const client = tavily({ apiKey });
      let safelistRegex: RegExp;
      try {
        safelistRegex = new RegExp(this.config.urlSafelist);
      } catch {
        ctx.logger.warn("WebSearchAgent: invalid urlSafelist regex, falling back to '.*'");
        safelistRegex = /./;
      }

      for (const q of queries.slice(0, this.config.maxQueryExpansions)) {
        queriesIssued++;
        ctx.logger.info(`WebSearchAgent: searching "${q.substring(0, 80)}"`);

        const resp: TavilySearchResponse = await client.search(q, {
          maxResults: this.config.maxResults,
          searchDepth: this.config.searchDepth,
          includeAnswer: this.config.includeAnswer,
          includeRawContent: "text",
        });

        const results = (resp.results ?? [])
          .filter((r) => safelistRegex.test(r.url ?? ""))
          .map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            content: (r.rawContent as string) ?? r.content ?? "",
            score: r.score ?? 0,
          }));

        urlsCrawled += results.length;
        allResults.push(...results);
      }
    } catch (err) {
      ctx.logger.warn("WebSearchAgent: search failed, degrading gracefully", {
        error: (err as Error).message,
      });
      return {
        data: { webContext: "", webSources: [], webSearchCompleted: false },
        metrics: { webSearchQueries: queriesIssued, urlsCrawled, webSearchEnabled: true, error: 1 },
      };
    }

    if (allResults.length === 0) {
      return {
        data: { webContext: "", webSources: [], webSearchCompleted: true },
        metrics: { webSearchQueries: queriesIssued, urlsCrawled, webSearchEnabled: true },
      };
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const unique = allResults.filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    // LLM-based reranking
    const reranked = await this.rerank(unique, query, ctx);

    const topResults = reranked.slice(0, this.config.maxResults);
    const webContext = topResults
      .map((r) => `[${r.title}] ${r.content.substring(0, 800)}`).join("\n\n---\n\n");
    const webSources = topResults.map((r) => r.url);

    ctx.logger.info(`WebSearchAgent: ${topResults.length} results after reranking`);

    return {
      data: { webContext, webSources, webSearchCompleted: true },
      metrics: {
        webSearchQueries: queriesIssued,
        urlsCrawled,
        webSearchEnabled: true,
        resultsAfterRerank: topResults.length,
      },
    };
  }

  private async rerank(
    results: SearchResult[],
    query: string,
    ctx: WorkflowContext,
  ): Promise<SearchResult[]> {
    if (results.length <= 1) return results;

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("priha/web-search-rerank", {
        query,
        results: JSON.stringify(
          results.map((r, i) => ({ index: i, title: r.title, snippet: r.content.substring(0, 300) })),
        ),
      });

      const resp = await llm.invoke(messages);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as Array<{
        index?: number;
        relevance?: number;
      }>;

      const scores = new Map<number, number>();
      for (const p of parsed) {
        if (p.index !== undefined && p.relevance !== undefined) {
          scores.set(p.index, p.relevance);
        }
      }

      const scored = results.map((r, i) => ({
        ...r,
        score: r.score + (scores.get(i) ?? 0.5) * 10,
      }));

      scored.sort((a, b) => b.score - a.score);
      return scored;
    } catch (err) {
      ctx.logger.warn("WebSearchAgent: LLM reranking failed, using default scores", {
        error: (err as Error).message,
      });
      return results.sort((a, b) => b.score - a.score);
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
