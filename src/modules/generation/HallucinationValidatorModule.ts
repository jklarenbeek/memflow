/**
 * HallucinationValidatorModule — post-generation LLM validation (PriHA)
 * Reads:  finalAnswer, retrievalResult
 * Writes: finalAnswer (with validation notes if needed)
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, RetrievalResult } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({});
type Config = z.infer<typeof ConfigSchema>;

export class HallucinationValidatorModule implements BaseModule<Config> {
  readonly name = "HallucinationValidator";
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    let answer = (input.data.finalAnswer as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;
    const fusedContext = retrieval?.chunks.map((c) => c.pageContent).join("\n\n") ?? "";

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("priha/validation", {
        answer: answer.substring(0, 2000),
        context: fusedContext.substring(0, 3000),
      });
      const resp = await llm.invoke(messages);
      const valText = typeof resp.content === "string" ? resp.content : "";
      if (!valText.includes("VALID")) {
        answer = `${answer}\n\n[VALIDATION NOTE: Some claims may need verification. ${valText}]`;
      }
      ctx.logger.info("HallucinationValidator: Validation complete");
      return { data: { finalAnswer: answer }, metrics: { validated: true, passed: valText.includes("VALID") } };
    } catch {
      ctx.logger.debug("HallucinationValidator: Validation skipped");
      return { data: { finalAnswer: answer }, metrics: { validated: false } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
