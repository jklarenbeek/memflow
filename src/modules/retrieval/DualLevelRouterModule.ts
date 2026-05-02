/**
 * DualLevelRouterModule — LightRAG dual-level retrieval routing
 *
 * The LightRAG paper distinguishes low-level (specific entities and
 * relationships) vs high-level (themes/topics) retrieval. This module
 * analyzes the query and classifies the retrieval level, then generates
 * appropriate sub-queries for each level.
 *
 * Low-level: extracts entity names and relationship patterns for
 *   direct graph traversal (e.g. "What did Alice say to Bob?")
 * High-level: extracts theme/topic keywords for community-level
 *   retrieval (e.g. "What are the main themes of the story?")
 * Hybrid: routes to both levels for complex queries
 *
 * Pipeline position: between IntentClassifier and the parallel
 * search fan-out in hybrid-retrieval.json.
 *
 * Reads:  query, searchScope
 * Writes: retrievalLevel, lowLevelQueries, highLevelQueries
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Default retrieval level when classification fails */
  defaultLevel: z.enum(["low", "high", "hybrid"]).default("hybrid"),
  /** Max low-level entity queries to generate */
  maxLowLevelQueries: z.number().default(5),
  /** Max high-level theme queries to generate */
  maxHighLevelQueries: z.number().default(3),
});
type DualLevelConfig = z.infer<typeof ConfigSchema>;

export class DualLevelRouterModule implements BaseModule<DualLevelConfig> {
  readonly name = "DualLevelRouter";
  readonly version = "0.5.0";
  private config: DualLevelConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<DualLevelConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const searchScope = (input.data.searchScope as string) ?? "full";

    let retrievalLevel: "low" | "high" | "hybrid" = this.config.defaultLevel;
    let lowLevelQueries: string[] = [];
    let highLevelQueries: string[] = [];

    try {
      const llm = ctx.getLLM();

      const resp = await llm.invoke([
        {
          role: "system",
          content: `You are a retrieval level classifier for a knowledge graph system.

Classify the query into one of three retrieval levels:
- "low": The query asks about SPECIFIC entities, relationships, or facts (names, dates, quantities, direct associations).
  → Extract entity names and relationship patterns for direct graph traversal.
- "high": The query asks about THEMES, TOPICS, summaries, or abstract concepts (trends, overviews, comparisons).
  → Extract theme/topic keywords for community-level retrieval.
- "hybrid": The query combines both specific and thematic aspects.
  → Extract both entity queries and theme queries.

Respond with JSON:
{
  "level": "low" | "high" | "hybrid",
  "lowLevelQueries": ["entity/relationship query 1", ...],
  "highLevelQueries": ["theme/topic query 1", ...],
  "reasoning": "brief explanation"
}`,
        },
        {
          role: "user",
          content: `Query: "${query}"\nSearch scope: ${searchScope}`,
        },
      ]);

      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      if (parsed.level && ["low", "high", "hybrid"].includes(parsed.level)) {
        retrievalLevel = parsed.level;
      }

      lowLevelQueries = (parsed.lowLevelQueries ?? [])
        .slice(0, this.config.maxLowLevelQueries)
        .filter((q: unknown): q is string => typeof q === "string" && q.length > 0);

      highLevelQueries = (parsed.highLevelQueries ?? [])
        .slice(0, this.config.maxHighLevelQueries)
        .filter((q: unknown): q is string => typeof q === "string" && q.length > 0);

      ctx.logger.info(
        `DualLevelRouter: level=${retrievalLevel}, low=${lowLevelQueries.length}, high=${highLevelQueries.length}`,
      );
    } catch {
      // Fallback: use heuristic classification
      retrievalLevel = this.heuristicClassify(query);
      if (retrievalLevel === "low" || retrievalLevel === "hybrid") {
        lowLevelQueries = [query];
      }
      if (retrievalLevel === "high" || retrievalLevel === "hybrid") {
        highLevelQueries = [query];
      }
      ctx.logger.debug(`DualLevelRouter: using heuristic fallback, level=${retrievalLevel}`);
    }

    return {
      data: {
        retrievalLevel,
        lowLevelQueries,
        highLevelQueries,
      },
      metrics: {
        level: retrievalLevel,
        lowQueries: lowLevelQueries.length,
        highQueries: highLevelQueries.length,
      },
    };
  }

  /**
   * Heuristic classification when LLM is unavailable.
   * Entity-specific indicators → low, theme indicators → high, else hybrid.
   */
  private heuristicClassify(query: string): "low" | "high" | "hybrid" {
    const lower = query.toLowerCase();

    // Low-level indicators: specific entity questions
    const lowPatterns = /\b(who|which|where|when|what is|name|date|how many|how much|between)\b/i;
    // High-level indicators: thematic/abstract questions
    const highPatterns = /\b(theme|summary|overview|trend|compare|general|main|overall|what are the|describe)\b/i;

    const hasLow = lowPatterns.test(lower);
    const hasHigh = highPatterns.test(lower);

    if (hasLow && hasHigh) return "hybrid";
    if (hasLow) return "low";
    if (hasHigh) return "high";
    return "hybrid";
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
