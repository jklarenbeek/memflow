/**
 * MultiTurnClarifierModule — user-facing clarification (Pattern B)
 *
 * Extends QueryClarifier's LLM-internal loop with user-facing questions
 * and stateful conversation history. Generates clarification questions
 * for the user to disambiguate fuzzy intent before retrieval.
 *
 * Reads:  query, userClarificationResponse
 * Writes: clarificationState, query (refined), expandedQueries
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { emitPatternEvent } from "../emitPatternEvent.js";
import { ClarificationStateSchema, type ClarificationState } from "../types.js";

const ConfigSchema = z.object({
  maxTurns: z.number().min(1).max(10).default(5),
  complexityGate: z.boolean().default(true),
  intentSchema: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;

export class MultiTurnClarifierModule implements BaseModule<Config> {
  readonly name = "MultiTurnClarifier";
  readonly version = "0.5.1";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const userResponse = input.data.userClarificationResponse as string | undefined;

    // Resume existing state or create new
    let state = input.data.clarificationState as ClarificationState | undefined;
    if (!state) {
      state = {
        originalQuery: query,
        turns: [],
        currentTurn: 0,
        intentResolved: false,
      };
    }

    // If complexity gate is on and query is clear, skip clarification
    if (this.config.complexityGate && !this.isFuzzyQuery(query) && state.turns.length === 0) {
      state.intentResolved = true;
      state.refinedQuery = query;
      return {
        data: { clarificationState: state, query },
        metrics: { _patternId: "clarification_pipeline", clarified: false, skippedComplexityGate: true },
      };
    }

    // If user provided a response, record it and try to resolve
    if (userResponse && state.turns.length > 0) {
      const lastTurn = state.turns[state.turns.length - 1];
      lastTurn.response = userResponse;

      const resolution = await this.tryResolveIntent(ctx, state);
      if (resolution.resolved) {
        state.intentResolved = true;
        state.refinedQuery = resolution.refinedQuery;
        state.detectedIntent = resolution.intent;
        state.expandedQueries = resolution.subQueries;

        // Emit resolved event
        emitPatternEvent(context, "clarification_pipeline", "clarification:resolved", this.name, {
          turns: state.currentTurn,
          refinedQuery: resolution.refinedQuery,
        });

        return {
          data: {
            clarificationState: state,
            query: resolution.refinedQuery,
            expandedQueries: resolution.subQueries,
          },
          metrics: { _patternId: "clarification_pipeline", clarified: true, turns: state.currentTurn },
        };
      }
    }

    // Check if we've exceeded max turns
    if (state.currentTurn >= this.config.maxTurns) {
      state.intentResolved = true;
      state.refinedQuery = query;
      ctx.logger.info("MultiTurnClarifier: Max turns reached, using original query");
      return {
        data: { clarificationState: state, query },
        metrics: { _patternId: "clarification_pipeline", clarified: false, maxTurnsReached: true },
      };
    }

    // Generate clarification questions
    const questions = await this.generateQuestions(ctx, state);
    state.currentTurn++;
    state.turns.push({
      turn: state.currentTurn,
      questions,
      timestamp: new Date().toISOString(),
    });

    ctx.logger.info(`MultiTurnClarifier: Generated ${questions.length} questions (turn ${state.currentTurn})`);

    // Emit question event
    emitPatternEvent(context, "clarification_pipeline", "clarification:question", this.name, {
      turn: state.currentTurn,
      questionCount: questions.length,
    });

    return {
      data: {
        clarificationState: state,
        clarifications: questions,
      },
      metrics: { _patternId: "clarification_pipeline", clarified: false, pendingClarification: true, turn: state.currentTurn },
    };
  }

  private isFuzzyQuery(q: string): boolean {
    return q.length < 20 || (/better|best|should|how|what if/i.test(q) && !/specific|exact|list/i.test(q));
  }

  private async generateQuestions(ctx: WorkflowContext, state: ClarificationState): Promise<string[]> {
    const llm = ctx.getLLM();

    const historyContext = state.turns
      .map((t) => `Q: ${t.questions.join("; ")}\nA: ${t.response ?? "(no response)"}`)
      .join("\n");

    const prompt = [
      { type: "system" as const, content: "Generate clarification questions for an ambiguous query. Respond with JSON: {\"questions\": [\"q1\", \"q2\"]}" },
      { type: "user" as const, content: `Query: "${state.originalQuery}"\n${historyContext ? `\nPrevious turns:\n${historyContext}` : ""}\nGenerate 2-3 clarifying questions.` },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { questions?: string[] };
      return parsed.questions?.slice(0, 3) ?? ["Could you provide more details?"];
    } catch {
      return ["Could you provide more details about your query?"];
    }
  }

  private async tryResolveIntent(ctx: WorkflowContext, state: ClarificationState): Promise<{ resolved: boolean; refinedQuery: string; intent?: string; subQueries?: string[] }> {
    const llm = ctx.getLLM();

    const conversationHistory = state.turns
      .map((t) => `Questions: ${t.questions.join("; ")}\nUser response: ${t.response ?? "N/A"}`)
      .join("\n\n");

    const prompt = [
      { type: "system" as const, content: "Determine if the user's intent is now clear. Respond with JSON: {\"resolved\": true/false, \"refined_query\": \"...\", \"intent\": \"...\", \"sub_queries\": [\"...\"]}" },
      { type: "user" as const, content: `Original: "${state.originalQuery}"\n\nConversation:\n${conversationHistory}\n\nIs the intent clear enough to proceed?` },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      return {
        resolved: (parsed.resolved as boolean) ?? false,
        refinedQuery: (parsed.refined_query as string) ?? state.originalQuery,
        intent: parsed.intent as string | undefined,
        subQueries: parsed.sub_queries as string[] | undefined,
      };
    } catch {
      return { resolved: false, refinedQuery: state.originalQuery };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
