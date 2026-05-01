/**
 * IntentAwarePlannerModule — SimpleMem §2.3 Intent-Aware Retrieval Planning
 *
 * Implements the paper's retrieval planning mechanism:
 *
 *   {qₛₑₘ, qₗₑₓ, qₛᵧₘ, d} ~ P(q, H)
 *
 * where qₛₑₘ, qₗₑₓ, qₛᵧₘ are optimized queries for semantic, lexical,
 * and symbolic retrieval channels, and d is the adaptive retrieval depth.
 *
 * The planner uses LLM reasoning to decompose the query into three
 * complementary retrieval signals and estimate the retrieval depth
 * based on query complexity.
 *
 * Reads:  query (string), memoryUnits (MemoryUnit[]) — for context
 * Writes: expandedQueries (string[]) — [qₛₑₘ, qₗₑₓ, qₛᵧₘ]
 *         searchScope — JSON-encoded retrieval plan
 *         retrievalDepth — adaptive depth d
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Minimum retrieval depth (for simple queries) */
  minDepth: z.number().default(3),
  /** Maximum retrieval depth (for complex queries) */
  maxDepth: z.number().default(20),
});

type IntentAwarePlannerConfig = z.infer<typeof ConfigSchema>;

export class IntentAwarePlannerModule implements BaseModule<IntentAwarePlannerConfig> {
  readonly name = "IntentAwarePlanner";
  readonly version = "0.2.0";
  private config: IntentAwarePlannerConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<IntentAwarePlannerConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const memories = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (!query.trim()) {
      return {
        data: { expandedQueries: [], searchScope: "full", retrievalDepth: this.config.minDepth },
        metrics: { planned: false },
      };
    }

    // Build conversation history context from recent memories
    const recentContext = memories
      .slice(-5)
      .map((u) => `[${u.type}] ${u.content.substring(0, 100)}`)
      .join("\n");

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("simplemem/intent_aware_planning", {
        query,
        history_context: recentContext || "No prior conversation context.",
        min_depth: this.config.minDepth,
        max_depth: this.config.maxDepth,
      });

      const resp = await llm.invoke(messages);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
        semantic_query?: string;
        lexical_query?: string;
        symbolic_filter?: string;
        depth?: number;
        complexity?: string;
      };

      const qSem = parsed.semantic_query ?? query;
      const qLex = parsed.lexical_query ?? this.extractKeywords(query);
      const qSym = parsed.symbolic_filter ?? "{}";
      const depth = Math.max(
        this.config.minDepth,
        Math.min(this.config.maxDepth, parsed.depth ?? this.estimateDepth(query)),
      );

      ctx.logger.info(
        `IntentAwarePlanner: depth=${depth}, complexity=${parsed.complexity ?? "unknown"}`,
      );

      return {
        data: {
          expandedQueries: [qSem, qLex, qSym],
          searchScope: JSON.stringify({
            mode: "multi-view",
            depth,
            complexity: parsed.complexity ?? "medium",
          }),
          retrievalDepth: depth,
          // Expose individual queries for downstream parallel retrieval
          semanticQuery: qSem,
          lexicalQuery: qLex,
          symbolicFilter: qSym,
        },
        metrics: {
          planned: 1,
          depth,
          complexity: parsed.complexity ?? "medium",
        },
      };
    } catch {
      // Fallback: heuristic planning
      const depth = this.estimateDepth(query);
      const qLex = this.extractKeywords(query);

      ctx.logger.debug(
        `IntentAwarePlanner: Fallback planning, depth=${depth}`,
      );

      return {
        data: {
          expandedQueries: [query, qLex, "{}"],
          searchScope: JSON.stringify({ mode: "multi-view", depth, complexity: "unknown" }),
          retrievalDepth: depth,
          semanticQuery: query,
          lexicalQuery: qLex,
          symbolicFilter: "{}",
        },
        metrics: { planned: 0, depth },
      };
    }
  }

  /**
   * Heuristic depth estimation based on query characteristics.
   * Simple queries → low depth, multi-hop → high depth.
   */
  private estimateDepth(query: string): number {
    const words = query.split(/\s+/).length;
    const hasMultipleEntities = (query.match(/\b[A-Z][a-z]+\b/g) ?? []).length > 1;
    const hasComplexIndicators = /compare|contrast|relationship|between|timeline|history|all|every/i.test(query);

    if (hasComplexIndicators || hasMultipleEntities) {
      return Math.min(this.config.maxDepth, 15);
    }
    if (words > 10) return 8;
    if (words > 5) return 5;
    return this.config.minDepth;
  }

  /**
   * Extract keywords for lexical retrieval channel.
   */
  private extractKeywords(query: string): string {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "have", "has", "had", "do", "does", "did", "will", "would",
      "could", "should", "may", "might", "can", "shall", "to", "of",
      "in", "for", "on", "with", "at", "by", "from", "as", "into",
      "about", "what", "which", "who", "when", "where", "how", "why",
      "that", "this", "it", "they", "them", "its", "and", "or", "but",
      "not", "no", "so", "if", "then", "than", "very", "just", "also",
    ]);

    return query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w))
      .join(" ");
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
