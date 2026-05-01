/**
 * LLM Provider Factory
 *
 * Creates LangChain chat model instances from config. Supports:
 *  - Ollama (local)
 *  - OpenRouter (any model via OpenAI-compatible API)
 *  - OpenAI (native)
 *
 * Used by WorkflowContext to provide per-module LLM overrides.
 */

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { ProviderError } from "../core/errors.js";

export const LLMConfigSchema = z.object({
  provider: z.enum(["ollama", "openrouter", "openai"]).default("ollama"),
  model: z.string().default("llama3.2"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().positive().default(4096),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

/** Create a LangChain BaseChatModel from config. */
export function createLLM(config: Partial<LLMConfig> = {}): BaseChatModel {
  const parsed = LLMConfigSchema.parse(config);

  if (parsed.provider === "ollama") {
    return new ChatOllama({
      baseUrl: parsed.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      model: parsed.model,
      temperature: parsed.temperature,
      maxRetries: 3,
    });
  }

  // OpenRouter and OpenAI share the ChatOpenAI class
  const apiKey =
    parsed.apiKey ??
    (parsed.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY);

  if (!apiKey) {
    throw new ProviderError(
      parsed.provider,
      `API key required. Set ${parsed.provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY"} env var.`,
    );
  }

  return new ChatOpenAI({
    modelName:
      parsed.model ??
      (parsed.provider === "openrouter"
        ? "anthropic/claude-3.5-sonnet"
        : "gpt-4o-mini"),
    openAIApiKey: apiKey,
    configuration:
      parsed.provider === "openrouter"
        ? {
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: {
              "HTTP-Referer": "https://memflow.dev",
              "X-Title": "MemFlow",
            },
          }
        : undefined,
    temperature: parsed.temperature,
    maxTokens: parsed.maxTokens,
  });
}
