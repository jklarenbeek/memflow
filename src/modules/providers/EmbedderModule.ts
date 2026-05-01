/**
 * EmbedderModule — workflow adapter for embedding providers
 *
 * Uses the shared WorkflowContext embeddings provider, with optional
 * per-module config override.
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { Document } from "@langchain/core/documents";

const ConfigSchema = z.object({
  provider: z.enum(["ollama", "openai", "openrouter"]).default("ollama"),
  model: z.string().default("nomic-embed-text"),
});

type EmbedderConfig = z.infer<typeof ConfigSchema>;

export class EmbedderModule implements BaseModule<EmbedderConfig> {
  readonly name = "Embedder";
  readonly version = "0.2.0";
  private config: EmbedderConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<EmbedderConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const embedder = ctx.getEmbeddings({
      embedderProvider: this.config.provider,
      embedderModel: this.config.model,
    });

    const docs = (input.data.chunks ?? input.data.documents ?? []) as Document[];
    const texts = docs.map((d) => d.pageContent ?? String(d));

    if (texts.length === 0) {
      return { data: { embeddings: [] }, metrics: { embedded: 0 } };
    }

    const embeddings = await embedder.embedDocuments(texts);
    return {
      data: { embeddings },
      metrics: { embedded: texts.length, dim: embeddings[0]?.length ?? 0 },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}