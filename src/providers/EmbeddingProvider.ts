/**
 * Embedding Provider Factory
 *
 * Creates LangChain Embeddings instances from config. Supports:
 *  - Ollama (local, e.g. nomic-embed-text)
 *  - OpenRouter (via OpenAI-compatible API)
 *  - OpenAI (text-embedding-3-small, etc.)
 *
 * Used by WorkflowContext to provide per-module embedding overrides.
 */

import { OllamaEmbeddings } from "@langchain/ollama";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Embeddings } from "@langchain/core/embeddings";
import { z } from "zod";
import { ProviderError } from "../core/errors.js";

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

  if (parsed.provider === "ollama") {
    return new OllamaEmbeddings({
      model: parsed.model,
      baseUrl: parsed.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
  }

  const apiKey =
    parsed.apiKey ??
    (parsed.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY);

  if (!apiKey) {
    throw new ProviderError(
      parsed.provider,
      `API key required for embeddings.`,
    );
  }

  return new OpenAIEmbeddings({
    modelName: parsed.model || "text-embedding-3-small",
    openAIApiKey: apiKey,
    configuration:
      parsed.provider === "openrouter"
        ? { baseURL: "https://openrouter.ai/api/v1" }
        : undefined,
    dimensions: parsed.dimensions,
  });
}
