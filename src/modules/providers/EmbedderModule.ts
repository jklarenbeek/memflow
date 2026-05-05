/**
 * EmbedderModule — workflow adapter for embedding providers
 *
 * Uses the SINGLETON embedding model from WorkflowContext.
 *
 * IMPORTANT: The embedding model is a system-level singleton, locked at
 * initialization. All modules share the same embedding model because
 * vectors from different models are incompatible in the same vector index.
 * Per-module model overrides are NOT supported for embeddings (unlike LLM).
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
  // No provider/model config — uses the system singleton
});

type EmbedderConfig = z.infer<typeof ConfigSchema>;

export class EmbedderModule implements BaseModule<EmbedderConfig> {
  readonly name = "Embedder";
  readonly version = "0.6.0";
  private config: EmbedderConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<EmbedderConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    // Use the system-level singleton embeddings — no per-module override
    const embedder = ctx.getEmbeddings();

    const docs = (input.data.chunks ?? input.data.documents ?? []) as Document[];
    const texts = docs.map((d) => d.pageContent ?? String(d));

    if (texts.length === 0) {
      return { data: { embeddings: [] }, metrics: { embedded: 0 } };
    }

    const embeddings = await embedder.embedDocuments(texts);
    return {
      data: { embeddings },
      metrics: {
        embedded: texts.length,
        dim: embeddings[0]?.length ?? 0,
        model: ctx.embeddingModel,
      },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}