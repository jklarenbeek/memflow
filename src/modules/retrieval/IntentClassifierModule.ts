/**
 * IntentClassifierModule — LLM-driven search scope inference
 *
 * Reads:  query
 * Writes: searchScope (string)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({ defaultScope: z.string().default("full") });
type IntentConfig = z.infer<typeof ConfigSchema>;

export class IntentClassifierModule implements BaseModule<IntentConfig> {
  readonly name = "IntentClassifier";
  readonly version = "0.5.0";
  private config: IntentConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<IntentConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("retrieval/intent_inference", { query });
      const resp = await llm.invoke(messages);
      const text = typeof resp.content === "string" ? resp.content : "";
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      ctx.logger.debug(`IntentClassifier: type=${json.type}, scope=${json.scope}`);
      return { data: { searchScope: json.scope ?? this.config.defaultScope }, metrics: { intentType: json.type } };
    } catch {
      return { data: { searchScope: this.config.defaultScope }, metrics: {} };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
