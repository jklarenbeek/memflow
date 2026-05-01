/**
 * LLMProviderModule — workflow adapter for LLM providers
 *
 * Uses the shared WorkflowContext LLM provider, with optional
 * per-module config override. Fixes the original this.config bug.
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  provider: z.enum(["ollama", "openai", "openrouter"]).default("ollama"),
  model: z.string().default("llama3.2"),
  temperature: z.number().default(0.1),
});

type LLMConfig = z.infer<typeof ConfigSchema>;

export class LLMProviderModule implements BaseModule<LLMConfig> {
  readonly name = "LLMProvider";
  readonly version = "2.0.0";
  private config: LLMConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<LLMConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const llm = ctx.getLLM({
      llmProvider: this.config.provider,
      llmModel: this.config.model,
    });

    const prompt = (input.data.query as string) ?? "Hello from MemFlow";
    const response = await llm.invoke([{ role: "user", content: prompt }]);
    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    return {
      data: { finalAnswer: content },
      metrics: { provider: this.config.provider },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}