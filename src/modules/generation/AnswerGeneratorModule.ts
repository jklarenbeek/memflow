/**
 * AnswerGeneratorModule — dual-source fusion + LLM generation (PriHA)
 * Reads:  query, retrievalResult, finalAnswer (optional draft)
 * Writes: finalAnswer
 */
import { z } from "zod";
import type {
  StreamableModule,
  ModuleInput,
  ModuleOutput,
  RetrievalResult,
  StreamEvent,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { truncateToTokens } from "../../utils/tokens.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  enableDualSource: z.boolean().default(true),
  maxContextTokens: z.number().default(7000),
});
type Config = z.infer<typeof ConfigSchema>;

export class AnswerGeneratorModule implements StreamableModule<Config> {
  readonly name = "AnswerGenerator";
  readonly version = "0.5.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;
    const draftAnswer = input.data.finalAnswer as string | undefined;
    const llm = ctx.getLLM();

    // Dual-source fusion — prefer pre-reconciled context if available
    const fusedContext = (input.data.fusedContext as string) ?? this.buildFusedContext(retrieval);

    const prompt = draftAnswer
      ? loadAndRender("priha/refinement", { draft: draftAnswer, context: fusedContext })
      : loadAndRender("priha/generation", { query, context: fusedContext });

    const sources = (input.data.sources as string[]) ?? retrieval?.sources ?? ["internal-knowledge"];

    const resp = await llm.invoke(prompt.messages);
    const answer = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
    const confidence = retrieval ? Math.min(0.95, retrieval.score + 0.1) : 0.6;

    return {
      data: { finalAnswer: answer, sources, confidence },
      metrics: { confidence },
    };
  }

  /**
   * Streaming variant: yields tokens as stage:progress events.
   *
   * Uses LangChain's `.stream()` method for real-time token output.
   * Clients see the answer being generated character-by-character.
   */
  async *processStream(
    input: ModuleInput<Config>,
    context: unknown,
  ): AsyncGenerator<StreamEvent, ModuleOutput, undefined> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;
    const draftAnswer = input.data.finalAnswer as string | undefined;
    const llm = ctx.getLLM();

    const fusedContext = (input.data.fusedContext as string) ?? this.buildFusedContext(retrieval);

    const prompt = draftAnswer
      ? loadAndRender("priha/refinement", { draft: draftAnswer, context: fusedContext })
      : loadAndRender("priha/generation", { query, context: fusedContext });

    const sources = (input.data.sources as string[]) ?? retrieval?.sources ?? ["internal-knowledge"];

    // Stream tokens via LangChain's .stream()
    let answer = "";
    let tokenIndex = 0;

    try {
      const stream = await llm.stream(prompt.messages);

      for await (const chunk of stream) {
        const token = typeof chunk.content === "string" ? chunk.content : "";
        if (token) {
          answer += token;

          yield {
            type: "stage:progress" as const,
            stageId: "__current__", // Replaced by engine with actual stageId
            module: this.name,
            token,
            tokenIndex: tokenIndex++,
            timestamp: new Date().toISOString(),
          };
        }
      }
    } catch {
      // If streaming fails, fall back to non-streaming
      if (!answer) {
        const resp = await llm.invoke(prompt.messages);
        answer = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
      }
    }

    const confidence = retrieval ? Math.min(0.95, retrieval.score + 0.1) : 0.6;

    return {
      data: { finalAnswer: answer, sources, confidence },
      metrics: { confidence, tokensStreamed: tokenIndex },
    };
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  private buildFusedContext(retrieval: RetrievalResult | undefined): string {
    let fusedContext = "";
    if (this.config.enableDualSource && retrieval) {
      const staticParts = retrieval.chunks.filter(
        (c) => (c.metadata?.source as string)?.includes("guideline") || c.metadata?.type === "official",
      );
      const dynamicParts = retrieval.chunks.filter((c) => !staticParts.includes(c));
      fusedContext = `OFFICIAL GUIDELINES:\n${staticParts.map((c) => c.pageContent).join("\n---\n")}\n\nDYNAMIC CONTEXT:\n${dynamicParts.map((c) => c.pageContent).join("\n---\n")}`;
    } else {
      fusedContext = retrieval?.chunks.map((c) => c.pageContent).join("\n\n") ?? "";
    }
    return truncateToTokens(fusedContext, this.config.maxContextTokens);
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
