/**
 * OpenRouterLLM — Native @openrouter/sdk Chat Model
 *
 * Wraps the OpenRouter SDK in LangChain's `SimpleChatModel` interface
 * so that all downstream modules using `ctx.getLLM().invoke(messages)`
 * work unchanged.
 *
 * Unlike the embedding model (which is a system singleton), the LLM
 * CAN be swapped per-module — different modules may use different models
 * (e.g., cheap model for extraction, expensive model for profiling).
 *
 * Key features:
 *  - Non-streaming by default (returns full response)
 *  - Proper message format conversion (LangChain → OpenRouter)
 *  - Retry with exponential backoff for rate limits
 *  - MemFlow referer headers for OpenRouter leaderboards
 */

import {
  SimpleChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { OpenRouter } from "@openrouter/sdk";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenRouterLLMParams {
  /** OpenRouter API key */
  apiKey: string;
  /** Model identifier (e.g. "qwen/qwen3.6-35b-a3b") */
  model: string;
  /** Sampling temperature */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OpenRouterChatModel extends SimpleChatModel {
  private client: OpenRouter;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(params: OpenRouterLLMParams) {
    super({});
    this.client = new OpenRouter({
      apiKey: params.apiKey,
      httpReferer: "https://memflow.dev",
      appTitle: "MemFlow",
    });
    this.model = params.model;
    this.temperature = params.temperature ?? 0.1;
    this.maxTokens = params.maxTokens ?? 4096;
  }

  _llmType(): string {
    return "openrouter";
  }

  /**
   * Core generation method — called by LangChain's invoke/call chain.
   */
  async _call(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<string> {
    const formatted = this._formatMessages(messages);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.client.chat.send({
          chatRequest: {
            model: this.model,
            messages: formatted.map((m) => ({
              role: m.role as any,
              content: m.content,
            })),
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            stream: false,
          },
        });

        // Non-streaming response is ChatResult: { choices, ... }
        const result = response as any;
        const content = result?.choices?.[0]?.message?.content ?? "";
        return typeof content === "string" ? content : JSON.stringify(content);
      } catch (err) {
        const isRateLimit =
          (err as any)?.status === 429 ||
          (err as Error).message?.includes("rate limit");

        if (isRateLimit && attempt < 3) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw err;
      }
    }

    throw new Error("Exhausted retries for LLM call");
  }

  /**
   * Convert LangChain message types to OpenRouter-compatible format.
   */
  private _formatMessages(
    messages: BaseMessage[],
  ): Array<{ role: string; content: string }> {
    return messages.map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);

      // Map LangChain message types to OpenRouter roles
      const type = msg._getType();
      let role: string;
      switch (type) {
        case "system":
          role = "system";
          break;
        case "human":
          role = "user";
          break;
        case "ai":
          role = "assistant";
          break;
        case "function":
        case "tool":
          role = "tool";
          break;
        default:
          role = "user";
      }

      return { role, content };
    });
  }
}
