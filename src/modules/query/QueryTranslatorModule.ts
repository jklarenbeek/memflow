/**
 * QueryTranslatorModule — multi-technique query expansion
 *
 * Enhanced from original MF implementation to use real LLM calls for HyDE
 * and step-back techniques, while keeping simple string expansion as fallback.
 *
 * Techniques:
 *  - HyDE: Generate a hypothetical document that answers the query
 *  - Multi-query: Generate query variants for broader coverage
 *  - Step-back: Generate a broader context query
 *  - Query rewriting: Rephrase for clarity
 *  - Intent clarification: Disambiguate the query
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  techniques: z
    .array(
      z.enum([
        "hyde",
        "multi_query",
        "step_back",
        "query_rewriting",
        "intent_clarification",
      ]),
    )
    .default(["hyde", "multi_query"]),
  useLLM: z.boolean().default(true),
});

type QueryTranslatorConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class QueryTranslatorModule
  implements BaseModule<QueryTranslatorConfig>
{
  readonly name = "QueryTranslator";
  readonly version = "2.0.0";
  private config: QueryTranslatorConfig;
  private ctx?: WorkflowContext;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<QueryTranslatorConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const originalQuery =
      (input.data.query as string) ?? "What is MemFlow?";
    const translated: string[] = [originalQuery];

    for (const technique of this.config.techniques) {
      const variants = this.config.useLLM
        ? await this.applyWithLLM(technique, originalQuery, ctx)
        : this.applyFallback(technique, originalQuery);
      translated.push(...variants);
    }

    return {
      data: {
        query: translated[0],
        expandedQueries: translated,
      },
      metrics: {
        queryVariants: translated.length,
        techniqueCount: this.config.techniques.length,
      },
    };
  }

  private async applyWithLLM(
    technique: string,
    query: string,
    ctx: WorkflowContext,
  ): Promise<string[]> {
    const llm = ctx.getLLM();
    const prompts: Record<string, string> = {
      hyde: `Write a short paragraph that directly answers this question as if it were a passage from a relevant document: "${query}"`,
      multi_query: `Generate 2 alternative search queries for: "${query}". Output as JSON array: ["query1", "query2"]`,
      step_back: `What is the broader topic or principle behind this question: "${query}"? Respond with one broader question.`,
      query_rewriting: `Rewrite this question for maximum clarity: "${query}"`,
      intent_clarification: `What is the user really asking with: "${query}"? Rephrase as a clear, unambiguous query.`,
    };

    try {
      const resp = await llm.invoke([
        { role: "user", content: prompts[technique] ?? `Expand: ${query}` },
      ]);
      const text =
        typeof resp.content === "string" ? resp.content : String(resp.content);

      // Try to parse as JSON array for multi_query
      if (technique === "multi_query") {
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          return JSON.parse(match[0]) as string[];
        }
      }

      return [text.trim()];
    } catch {
      return this.applyFallback(technique, query);
    }
  }

  private applyFallback(technique: string, query: string): string[] {
    switch (technique) {
      case "hyde":
        return [
          `Hypothetical document: ${query} explained in detail with examples.`,
        ];
      case "multi_query":
        return [`${query} pros and cons`, `${query} implementation details`];
      case "step_back":
        return [`What is the broader context of: ${query}`];
      case "query_rewriting":
        return [`Detailed explanation of: ${query}`];
      case "intent_clarification":
        return [`The user wants to know: ${query}`];
      default:
        return [];
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}