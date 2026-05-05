/**
 * Embedding Provider Factory
 *
 * Creates LangChain Embeddings instances from config. Supports:
 *  - Ollama (local, e.g. nomic-embed-text)
 *  - OpenRouter (native @openrouter/sdk driver)
 *  - OpenAI (text-embedding-3-small, etc.)
 *
 * IMPORTANT: The embedding model is a SYSTEM-LEVEL SINGLETON.
 * Vectors from different models are incompatible in the same vector index.
 * The model is chosen at WorkflowContext initialization and locked for the
 * session. Do not swap embedding models mid-workflow.
 *
 * Used by WorkflowContext to create the singleton embeddings instance.
 */

import { OllamaEmbeddings } from "@langchain/ollama";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Embeddings } from "@langchain/core/embeddings";
import { z } from "zod";
import { ProviderError } from "../core/errors.js";
import { OpenRouterEmbeddings } from "./OpenRouterEmbeddings.js";
import { getModelSpec } from "./EmbeddingModelRegistry.js";

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(["ollama", "openrouter", "openai"]).default("ollama"),
  model: z.string().default("nomic-embed-text"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dimensions: z.number().optional(),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

/** Create a LangChain Embeddings instance from config. */
export function createEmbeddings(
  config: Partial<EmbeddingConfig> = {},
): Embeddings {
  const parsed = EmbeddingConfigSchema.parse(config);

  // ── Ollama (local) ──────────────────────────────────────────────────────
  if (parsed.provider === "ollama") {
    return new OllamaEmbeddings({
      model: parsed.model,
      baseUrl: parsed.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
  }

  // ── OpenRouter (native SDK) ─────────────────────────────────────────────
  if (parsed.provider === "openrouter") {
    const apiKey = parsed.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "openrouter",
        "API key required for embeddings. Set OPENROUTER_API_KEY env var.",
      );
    }

    const spec = getModelSpec(parsed.model);
    return new OpenRouterEmbeddings({
      apiKey,
      model: parsed.model,
      dimensions: parsed.dimensions ?? spec?.dimensions,
      maxSeqLen: spec?.maxSeqLen,
    });
  }

  // ── OpenAI (native) ─────────────────────────────────────────────────────
  const apiKey = parsed.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      "openai",
      "API key required for embeddings. Set OPENAI_API_KEY env var.",
    );
  }

  return new OpenAIEmbeddings({
    modelName: parsed.model || "text-embedding-3-small",
    openAIApiKey: apiKey,
    dimensions: parsed.dimensions,
  });
}
