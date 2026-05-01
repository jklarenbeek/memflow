/**
 * PriHAFusionModule — triage, dual-source fusion, and validation
 *
 * Ported from HRW's PriHAFusion (102 lines). Implements:
 *
 *  1. Intelligent triage: clarifies ambiguous queries before generation
 *  2. Dual-source fusion: separates official/guideline sources from
 *     dynamic/graph context for balanced generation
 *  3. Hallucination validation: post-generation LLM check
 *  4. Inline citation generation
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  RetrievalResult,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { truncateToTokens } from "../../utils/tokens.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  enableTriage: z.boolean().default(true),
  enableDualSource: z.boolean().default(true),
  enableValidation: z.boolean().default(true),
  citationStyle: z.enum(["inline", "footnote"]).default("inline"),
  maxCitations: z.number().default(6),
  maxContextTokens: z.number().default(7000),
  /** Max depth for iterative query clarification (PHC-O pattern) */
  maxClarificationDepth: z.number().default(2),
  /** Max sub-queries to decompose a fuzzy query into */
  maxSubQueries: z.number().default(3),
});

type PriHAConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class PriHAFusionModule implements BaseModule<PriHAConfig> {
  readonly name = "PriHAFusion";
  readonly version = "1.0.0";
  private config: PriHAConfig;
  private ctx?: WorkflowContext;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<PriHAConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const query = (input.data.query as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;
    const draftAnswer = input.data.finalAnswer as string | undefined;

    ctx.logger.info("PriHAFusion: Fusing and validating response");
    const llm = ctx.getLLM();

    let clarifications: string[] = [];
    let workingQuery = query;
    let subQueries: string[] = [];

    // 1. Automated multi-query clarification (PHC-O Query Optimizer pattern)
    //    Instead of single-shot triage, iteratively decompose fuzzy queries
    //    into specific sub-queries for comprehensive coverage
    if (this.config.enableTriage && this.isFuzzyQuery(query)) {
      for (let depth = 0; depth < this.config.maxClarificationDepth; depth++) {
        try {
          const resp = await llm.invoke([
            {
              role: "user",
              content: `The user asked: "${workingQuery}". ${depth === 0 ? "This is ambiguous." : "The previous decomposition needs refinement."}
Decompose into ${this.config.maxSubQueries} specific, self-contained sub-queries.
Output JSON: {"clarifications": ["what is missing"], "subqueries": ["specific query 1", "specific query 2"]}`,
            },
          ]);
          const text =
            typeof resp.content === "string" ? resp.content : "";
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
          clarifications = parsed.clarifications ?? [];

          if (parsed.subqueries?.length) {
            subQueries = parsed.subqueries.slice(0, this.config.maxSubQueries);
            // Check if sub-queries are specific enough (not fuzzy)
            const allSpecific = subQueries.every((sq: string) => !this.isFuzzyQuery(sq));
            if (allSpecific) break;
            // If still fuzzy, refine in next iteration
            workingQuery = subQueries[0] ?? workingQuery;
          } else {
            break;
          }
        } catch {
          // Triage is optional — continue with original query
          break;
        }
      }

      if (subQueries.length > 0) {
        workingQuery = subQueries.join(" AND ");
      }
    }

    // 2. Dual-source fusion
    let fusedContext = "";
    if (this.config.enableDualSource && retrieval) {
      const staticParts = retrieval.chunks.filter(
        (c) =>
          (c.metadata?.source as string)?.includes("guideline") ||
          c.metadata?.type === "official",
      );
      const dynamicParts = retrieval.chunks.filter(
        (c) => !staticParts.includes(c),
      );

      fusedContext = `OFFICIAL GUIDELINES:\n${staticParts.map((c) => c.pageContent).join("\n---\n")}\n\nDYNAMIC CONTEXT:\n${dynamicParts.map((c) => c.pageContent).join("\n---\n")}`;
    } else {
      fusedContext =
        retrieval?.chunks.map((c) => c.pageContent).join("\n\n") ?? "";
    }

    fusedContext = truncateToTokens(fusedContext, this.config.maxContextTokens);

    // 3. Generate or refine answer
    const genPrompt = draftAnswer
      ? `Refine and validate this draft using the context. Add missing citations and fix inaccuracies.\n\nDraft: ${draftAnswer}\n\nContext: ${fusedContext}`
      : `Answer the query using ONLY the provided context. Cite sources inline as [1], [2]. Be precise.\n\nQuery: ${workingQuery}\n\nContext: ${fusedContext}`;

    const response = await llm.invoke([{ role: "user", content: genPrompt }]);
    let answer =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    // 4. Hallucination validation
    if (this.config.enableValidation) {
      answer = await this.validateAnswer(answer, fusedContext, ctx);
    }

    // 5. Add citations
    const sources = retrieval?.sources ?? ["internal-knowledge"];
    if (this.config.citationStyle === "inline") {
      answer = this.addInlineCitations(answer, sources);
    }

    const confidence = retrieval
      ? Math.min(0.95, retrieval.score + 0.1)
      : 0.6;

    return {
      data: {
        finalAnswer: answer,
        sources: sources.slice(0, this.config.maxCitations),
        confidence,
      },
      metrics: {
        confidence,
        hasClarifications: clarifications.length > 0 ? 1 : 0,
        sourceCount: sources.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private isFuzzyQuery(q: string): boolean {
    return (
      q.length < 20 ||
      (/better|best|should|how|what if/i.test(q) &&
        !/specific|exact|list/i.test(q))
    );
  }

  private async validateAnswer(
    answer: string,
    context: string,
    ctx: WorkflowContext,
  ): Promise<string> {
    try {
      const llm = ctx.getLLM();
      const resp = await llm.invoke([
        {
          role: "user",
          content: `Validate this answer against the context. Flag any unsupported claims. Output: "VALID" or "ISSUES: list"\nAnswer: ${answer.substring(0, 2000)}\nContext: ${context.substring(0, 3000)}`,
        },
      ]);
      const valText =
        typeof resp.content === "string" ? resp.content : "";
      if (!valText.includes("VALID")) {
        return `${answer}\n\n[VALIDATION NOTE: Some claims may need verification. ${valText}]`;
      }
    } catch {
      ctx.logger.debug("Validation LLM call failed, skipping");
    }
    return answer;
  }

  private addInlineCitations(answer: string, sources: string[]): string {
    if (!answer.includes("[")) {
      return `${answer}\n\nSources: ${sources.map((s, i) => `[${i + 1}] ${s}`).join(" ")}`;
    }
    return answer;
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
