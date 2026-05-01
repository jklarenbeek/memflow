/**
 * WebSearchAgentModule — PriHA §3.3 Web Search Agent (STUB)
 *
 * Future implementation: ReAct-style iterative web search with
 * safelist URL validation, LLM-based reranking, and crawling.
 *
 * The PriHA paper's core contribution is dual retrieval: local
 * knowledge base + live web search via a Web Search Agent (WSA).
 * This stub provides the interface and data contract so that
 * downstream modules (PriHA Reconciler, CitationInjector) can
 * be developed against the expected output shape.
 *
 * When fully implemented, the WSA will:
 *  1. Receive the optimized query from PHC-O (QueryClarifier)
 *  2. Execute iterative web searches via a search API
 *  3. Crawl and extract content from top results
 *  4. Rerank results using LLM relevance scoring
 *  5. Return structured web context (Cweb) with traceable URLs
 *
 * Reads:  query, expandedQueries
 * Writes: webContext (string), webSources (string[]), webSearchCompleted (boolean)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Maximum number of web search results to process */
  maxResults: z.number().default(5),
  /** Maximum crawl depth per result */
  maxCrawlDepth: z.number().default(1),
  /** Search API provider (future: "serp", "brave", "tavily") */
  searchProvider: z.string().default("none"),
  /** URL safelist pattern (regex) for allowed domains */
  urlSafelist: z.string().default(".*"),
});
type WebSearchConfig = z.infer<typeof ConfigSchema>;

export class WebSearchAgentModule implements BaseModule<WebSearchConfig> {
  readonly name = "WebSearchAgent";
  readonly version = "0.1.0";
  private config: WebSearchConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<WebSearchConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    ctx.logger.warn(
      "WebSearchAgent: STUB — web search is not yet implemented. " +
      "Configure searchProvider to enable. See PriHA §3.3 for the target architecture.",
    );

    return {
      data: {
        webContext: "",
        webSources: [],
        webSearchCompleted: false,
      },
      metrics: {
        webSearchEnabled: false,
        searchProvider: this.config.searchProvider,
      },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
