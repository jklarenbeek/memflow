/**
 * AnswerGeneratorModule — dual-source fusion + LLM generation (PriHA)
 * Reads:  query, retrievalResult, finalAnswer (optional draft)
 * Writes: finalAnswer
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, RetrievalResult } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { truncateToTokens } from "../../utils/tokens.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  enableDualSource: z.boolean().default(true),
  maxContextTokens: z.number().default(7000),
});
type Config = z.infer<typeof ConfigSchema>;

export class AnswerGeneratorModule implements BaseModule<Config> {
  readonly name = "AnswerGenerator";
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;
    const draftAnswer = input.data.finalAnswer as string | undefined;
    const llm = ctx.getLLM();

    // Dual-source fusion
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
    fusedContext = truncateToTokens(fusedContext, this.config.maxContextTokens);

    const prompt = draftAnswer
      ? loadAndRender("priha/refinement", { draft: draftAnswer, context: fusedContext })
      : loadAndRender("priha/generation", { query, context: fusedContext });

    const resp = await llm.invoke(prompt.messages);
    const answer = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
    const confidence = retrieval ? Math.min(0.95, retrieval.score + 0.1) : 0.6;

    return {
      data: { finalAnswer: answer, sources: retrieval?.sources ?? ["internal-knowledge"], confidence },
      metrics: { confidence },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
