/**
 * FactExtractorModule — de-linearise text into atomic memory units
 *
 * Extracted from SimpleMem. Uses LLM to extract structured facts
 * from combined chunk text, creating typed MemoryUnit objects with
 * embeddings and timestamps.
 *
 * Reads:  filteredChunks (Document[]) or chunks (Document[])
 * Writes: memoryUnits (MemoryUnit[]) — appended to existing
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import { v4 as uuid } from "uuid";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";
import { estimateTokens } from "../../utils/tokens.js";

const ConfigSchema = z.object({
  /** Max facts to extract per chunk */
  maxFactsPerChunk: z.number().default(8),
});

type FactExtractorConfig = z.infer<typeof ConfigSchema>;

export class FactExtractorModule implements BaseModule<FactExtractorConfig> {
  readonly name = "FactExtractor";
  readonly version = "0.5.0";
  private config: FactExtractorConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

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
    const newUnits: MemoryUnit[] = [];

    // Improvement #7: Extract modelId and providerId from context for provenance tracking
    const modelId = ctx.globalConfig.llmModel ?? "unknown";
    const providerId = ctx.globalConfig.llmProvider ?? "unknown";

    // Improvement #10: Track telemetry counters
    let embeddingCalls = 0;
    let tokenUsage = 0;

    for (const chunk of chunks) {
      try {
        const { messages } = loadAndRender("simplemem/extraction", {
          content: chunk.pageContent.substring(0, 2000),
        });

        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
        tokenUsage += estimateTokens(text);
        const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as Array<{
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
          embeddingCalls++;
        } catch (embErr) {
          // Improvement #6: structured error logging
          ctx.logger.warn("FactExtractor: batch embedding failed", {
            error: (embErr as Error).message,
            factCount: factTexts.length,
          });
          embeddings = factTexts.map(() => []);
        }

        for (let i = 0; i < facts.length; i++) {
          const fact = facts[i];
          if (!fact.content?.trim()) continue;

          newUnits.push({
            id: uuid(),
            content: fact.content,
            embedding: embeddings[i] ?? [],
            timestamp: new Date(),
            type: (fact.type as MemoryUnit["type"]) ?? "fact",
            // Improvement #7: Populate provenance fields
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
        // Improvement #6: structured error logging instead of bare catch
        ctx.logger.warn("FactExtractor: LLM extraction failed for chunk, using fallback", {
          error: (err as Error).message,
          chunkSource: chunk.metadata?.source,
        });

        // Fallback: treat the entire chunk as a single fact
        let embedding: number[] = [];
        try {
          embedding = await embedder.embedQuery(chunk.pageContent.substring(0, 500));
          embeddingCalls++;
        } catch (embErr) {
          ctx.logger.debug("FactExtractor: fallback embedding failed", {
            error: (embErr as Error).message,
          });
        }

        newUnits.push({
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
    }

    ctx.logger.info(`FactExtractor: Extracted ${newUnits.length} facts from ${chunks.length} chunks`);

    return {
      data: { memoryUnits: [...existing, ...newUnits] },
      metrics: {
        extracted: newUnits.length,
        chunks: chunks.length,
        // Improvement #10: module-level telemetry
        embeddingCalls,
        tokenUsage,
      },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
