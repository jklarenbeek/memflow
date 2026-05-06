/**
 * FactExtractorModule — de-linearise text into atomic memory units
 *
 * Extracted from SimpleMem. Uses LLM to extract structured facts
 * from combined chunk text, creating typed MemoryUnit objects with
 * embeddings and timestamps.
 *
 * Implements StreamableModule for real-time per-chunk progress events
 * and concurrent chunk processing via Promise.allSettled().
 *
 * Reads:  filteredChunks (Document[]) or chunks (Document[])
 * Writes: memoryUnits (MemoryUnit[]) — appended to existing
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import { v4 as uuid } from "uuid";
import type {
  StreamableModule,
  StreamEvent,
  StreamEventStageProgress,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Max facts to extract per chunk */
  maxFactsPerChunk: z.number().default(8),
  /** Number of chunks to process concurrently (Promise.allSettled) */
  concurrency: z.number().min(1).max(10).default(3),
});

type FactExtractorConfig = z.infer<typeof ConfigSchema>;

/** Result from processing a single chunk */
interface ChunkResult {
  units: MemoryUnit[];
  promptPreview: string;
  responsePreview: string;
  failed: boolean;
}

export class FactExtractorModule implements StreamableModule<FactExtractorConfig> {
  readonly name = "FactExtractor";
  readonly version = "0.6.0";
  private config: FactExtractorConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  /**
   * Non-streaming process() — used by non-streaming callers and sub-workflows.
   * Delegates to the same core logic but without yielding events.
   */
  async process(
    input: ModuleInput<FactExtractorConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const chunks = (input.data.filteredChunks ?? input.data.chunks ?? []) as Document[];
    const existing = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (chunks.length === 0) {
      return { data: { memoryUnits: existing }, metrics: { extracted: 0 } };
    }

    const llm = ctx.getLLM();
    const embedder = ctx.getEmbeddings();
    const modelId = ctx.globalConfig.llmModel ?? "unknown";
    const providerId = ctx.globalConfig.llmProvider ?? "unknown";

    const allUnits: MemoryUnit[] = [];
    let embeddingCalls = 0;
    let tokenUsage = 0;
    let failedChunks = 0;

    // Process chunks concurrently in batches
    const CONCURRENCY = this.config.concurrency;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((chunk) => this.extractFromChunk(chunk, llm, embedder, modelId, providerId, ctx)),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          allUnits.push(...result.value.units);
          if (result.value.failed) failedChunks++;
        } else {
          failedChunks++;
        }
      }
    }

    tokenUsage = allUnits.length * 50; // rough estimate
    embeddingCalls = Math.ceil(chunks.length / CONCURRENCY);

    ctx.logger.info(`FactExtractor: Extracted ${allUnits.length} facts from ${chunks.length} chunks (${failedChunks} failed)`);

    return {
      data: { memoryUnits: [...existing, ...allUnits] },
      metrics: { extracted: allUnits.length, chunks: chunks.length, failedChunks, embeddingCalls, tokenUsage },
    };
  }

  /**
   * Streaming process — yields per-chunk progress events with LLM I/O previews.
   * Uses concurrent chunk processing via Promise.allSettled().
   */
  async *processStream(
    input: ModuleInput<FactExtractorConfig>,
    context: unknown,
  ): AsyncGenerator<StreamEvent, ModuleOutput, undefined> {
    const ctx = context as WorkflowContext;
    const chunks = (input.data.filteredChunks ?? input.data.chunks ?? []) as Document[];
    const existing = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (chunks.length === 0) {
      return { data: { memoryUnits: existing }, metrics: { extracted: 0 } };
    }

    const llm = ctx.getLLM();
    const embedder = ctx.getEmbeddings();
    const modelId = ctx.globalConfig.llmModel ?? "unknown";
    const providerId = ctx.globalConfig.llmProvider ?? "unknown";

    const allUnits: MemoryUnit[] = [];
    let failedChunks = 0;
    let processedCount = 0;

    // Process chunks concurrently in batches
    const CONCURRENCY = this.config.concurrency;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((chunk) => this.extractFromChunk(chunk, llm, embedder, modelId, providerId, ctx)),
      );

      for (const [j, result] of results.entries()) {
        processedCount++;
        const chunkResult = result.status === "fulfilled" ? result.value : null;

        if (chunkResult) {
          allUnits.push(...chunkResult.units);
          if (chunkResult.failed) failedChunks++;
        } else {
          failedChunks++;
        }

        // Yield a progress event for this chunk
        const progressEvent: StreamEventStageProgress = {
          type: "stage:progress",
          stageId: "extract",
          module: "FactExtractor",
          chunkIndex: processedCount,
          totalChunks: chunks.length,
          message: `Extracting facts: chunk ${processedCount}/${chunks.length}${failedChunks > 0 ? ` (${failedChunks} fallback)` : ""}`,
          detail: chunkResult ? {
            promptPreview: chunkResult.promptPreview,
            responsePreview: chunkResult.responsePreview,
            factsExtracted: chunkResult.units.length,
            failed: chunkResult.failed,
          } : {
            failed: true,
            error: result.status === "rejected" ? (result.reason as Error).message : "unknown",
          },
          timestamp: new Date().toISOString(),
        };
        yield progressEvent;
      }
    }

    ctx.logger.info(`FactExtractor: Extracted ${allUnits.length} facts from ${chunks.length} chunks (${failedChunks} failed)`);

    return {
      data: { memoryUnits: [...existing, ...allUnits] },
      metrics: { extracted: allUnits.length, chunks: chunks.length, failedChunks },
    };
  }

  /**
   * Extract facts from a single chunk — shared by both process() and processStream().
   */
  private async extractFromChunk(
    chunk: Document,
    llm: ReturnType<WorkflowContext["getLLM"]>,
    embedder: ReturnType<WorkflowContext["getEmbeddings"]>,
    modelId: string,
    providerId: string,
    ctx: WorkflowContext,
  ): Promise<ChunkResult> {
    const promptText = chunk.pageContent.substring(0, 2000);
    let responseText = "";
    let failed = false;
    const units: MemoryUnit[] = [];

    try {
      const { messages } = loadAndRender("simplemem/extraction", {
        content: promptText,
      });

      const resp = await llm.invoke(messages);
      responseText = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(responseText.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as Array<{
        content?: string;
        type?: string;
        importance?: number;
      }>;

      const facts = parsed.slice(0, this.config.maxFactsPerChunk);

      // Batch embed all extracted facts
      const factTexts = facts.map((f) => f.content ?? "");
      let embeddings: number[][] = [];
      try {
        embeddings = await embedder.embedDocuments(factTexts);
      } catch (embErr) {
        ctx.logger.warn("FactExtractor: batch embedding failed", {
          error: (embErr as Error).message,
          factCount: factTexts.length,
        });
        embeddings = factTexts.map(() => []);
      }

      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i];
        if (!fact.content?.trim()) continue;

        units.push({
          id: uuid(),
          content: fact.content,
          embedding: embeddings[i] ?? [],
          timestamp: new Date(),
          type: (fact.type as MemoryUnit["type"]) ?? "fact",
          modelId,
          providerId,
          metadata: {
            source: chunk.metadata?.source ?? "extraction",
            importance: fact.importance ?? 0.7,
            confidence: 0.8,
          },
        });
      }
    } catch (err) {
      failed = true;
      ctx.logger.warn("FactExtractor: LLM extraction failed for chunk, using fallback", {
        error: (err as Error).message,
        chunkSource: chunk.metadata?.source,
      });

      // Fallback: treat the entire chunk as a single fact
      let embedding: number[] = [];
      try {
        embedding = await embedder.embedQuery(chunk.pageContent.substring(0, 500));
      } catch (embErr) {
        ctx.logger.debug("FactExtractor: fallback embedding failed", {
          error: (embErr as Error).message,
        });
      }

      units.push({
        id: uuid(),
        content: chunk.pageContent.substring(0, 500),
        embedding,
        timestamp: new Date(),
        type: "fact",
        modelId,
        providerId,
        metadata: { source: "fallback-extraction" },
      });
    }

    return {
      units,
      promptPreview: promptText.substring(0, 200),
      responsePreview: responseText.substring(0, 200),
      failed,
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
