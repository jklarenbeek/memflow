/**
 * LLM Provider Factory
 *
 * Creates LangChain chat model instances from config. Supports:
 *  - Ollama     → @langchain/ollama  (ChatOllama)
 *  - OpenRouter → OpenRouterChatModel (native @openrouter/sdk wrapper)
 *  - OpenAI     → @langchain/openai  (ChatOpenAI)
 *
 * Unlike the embedding model, the LLM CAN be swapped per-module.
 * Different modules may use different LLMs (e.g., cheap model for
 * extraction, expensive model for profiling).
 */

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { ProviderError } from "../core/errors.js";
import { OpenRouterChatModel } from "./OpenRouterLLM.js";

export const LLMConfigSchema = z.object({
  provider: z.enum(["ollama", "openrouter", "openai"]).default("ollama"),
  model: z.string().default("qwen3.5:9b"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().positive().default(4096),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

/** Create a LangChain BaseChatModel from config. */
export function createLLM(config: Partial<LLMConfig> = {}): BaseChatModel {
  const parsed = LLMConfigSchema.parse(config);

  // ── Ollama (local) ──────────────────────────────────────────────────────
  if (parsed.provider === "ollama") {
    return new ChatOllama({
      baseUrl: parsed.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      model: parsed.model,
      temperature: parsed.temperature,
      maxRetries: 3,
    });
  }

  // ── OpenRouter (native @openrouter/sdk wrapper) ─────────────────────────
  // Uses our custom OpenRouterChatModel which wraps the @openrouter/sdk
  // in a LangChain SimpleChatModel interface. When the project migrates to
  // LangChain v1.x, this should be replaced with ChatOpenRouter from
  // @langchain/openrouter (which adds streaming, tool calling, structured
  // output, model routing, and provider fallbacks).
  if (parsed.provider === "openrouter") {
    const apiKey = parsed.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "openrouter",
        "API key required. Set OPENROUTER_API_KEY env var.",
      );
    }

    return new OpenRouterChatModel({
      apiKey,
      model: parsed.model ?? "anthropic/claude-3.5-sonnet",
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
    });
  }

  // ── OpenAI (native) ─────────────────────────────────────────────────────
  const apiKey = parsed.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderError(
      "openai",
      "API key required. Set OPENAI_API_KEY env var.",
    );
  }

  return new ChatOpenAI({
    modelName: parsed.model ?? "gpt-4o-mini",
    openAIApiKey: apiKey,
    temperature: parsed.temperature,
    maxTokens: parsed.maxTokens,
  });
}
