/**
 * OpenRouterEmbeddings — Native @openrouter/sdk Embeddings Provider
 *
 * Wraps the OpenRouter SDK in the LangChain `Embeddings` interface so that
 * all downstream modules (EmbedderModule, FactExtractorModule, S2Chunker, etc.)
 * work unchanged.
 *
 * Key features:
 *  - Per-text truncation using maxSeqLen from the model registry
 *  - Proper batch support (all texts in one API call)
 *  - Correct response parsing (data[i].embedding, not OpenAI format)
 *  - Retry with exponential backoff for rate limits
 *
 * IMPORTANT: The embedding model is a SYSTEM-LEVEL SINGLETON.
 * Vectors from different models are incompatible. Do not swap mid-workflow.
 */

import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { OpenRouter } from "@openrouter/sdk";
import { getMaxSeqLen, getDimensions } from "./EmbeddingModelRegistry.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenRouterEmbeddingsParams extends EmbeddingsParams {
  /** OpenRouter API key */
  apiKey: string;
  /** Model identifier (e.g. "nvidia/llama-nemotron-embed-vl-1b-v2:free") */
  model: string;
  /** Override dimensions (auto-detected from registry if omitted) */
  dimensions?: number;
  /** Override max sequence length in tokens (auto-detected from registry if omitted) */
  maxSeqLen?: number;
  /** Max texts per API call (some models limit batch size) */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OpenRouterEmbeddings extends Embeddings {
  private client: OpenRouter;
  private model: string;
  readonly dimensions: number;
  readonly maxSeqLen: number;
  private batchSize: number;

  constructor(params: OpenRouterEmbeddingsParams) {
    super(params);
    this.client = new OpenRouter({
      apiKey: params.apiKey,
    });
    this.model = params.model;
    this.dimensions = params.dimensions ?? getDimensions(params.model);
    this.maxSeqLen = params.maxSeqLen ?? getMaxSeqLen(params.model);
    this.batchSize = params.batchSize ?? 64;
  }

  /**
   * Embed multiple texts. Texts exceeding maxSeqLen are truncated.
   *
   * Uses the OpenRouter SDK `embeddings.generate()` endpoint which
   * returns `{ data: [{ embedding: number[] }, ...] }`.
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Truncate texts to fit model context window
    // Rough estimate: 1 token ≈ 4 chars (GPT-style)
    const maxChars = this.maxSeqLen * 4;
    const truncated = texts.map((t) =>
      t.length > maxChars ? t.substring(0, maxChars) : t,
    );

    // Process in batches
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < truncated.length; i += this.batchSize) {
      const batch = truncated.slice(i, i + this.batchSize);
      const embeddings = await this._embedBatch(batch);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  /**
   * Embed a single query text.
   */
  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedDocuments([text]);
    return embedding;
  }

  /**
   * Internal: embed a single batch via the OpenRouter SDK.
   */
  private async _embedBatch(
    texts: string[],
    retries = 3,
  ): Promise<number[][]> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.client.embeddings.generate({
          requestBody: {
            model: this.model,
            input: texts,
            encodingFormat: "float",
          },
        });

        // Response is CreateEmbeddingsResponseBody | string
        if (typeof response === "string") {
          throw new Error(`Unexpected string response: ${response.substring(0, 200)}`);
        }

        const body = response as { data?: Array<{ embedding?: number[] | string; index?: number }> };
        if (!body?.data || !Array.isArray(body.data)) {
          throw new Error(
            `Unexpected response shape: ${JSON.stringify(response).substring(0, 200)}`,
          );
        }

        // Sort by index to ensure correct ordering
        const sorted = [...body.data].sort(
          (a, b) => (a.index ?? 0) - (b.index ?? 0),
        );

        return sorted.map((item) => {
          const emb = item.embedding;
          if (!emb || typeof emb === "string") {
            throw new Error(
              `Missing or base64 embedding — ensure encodingFormat is 'float'`,
            );
          }
          return emb as number[];
        });
      } catch (err) {
        const isRateLimit =
          (err as any)?.status === 429 ||
          (err as Error).message?.includes("rate limit");

        if (isRateLimit && attempt < retries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw err;
      }
    }

    // Should never reach here
    throw new Error("Exhausted retries for embedding batch");
  }
}
