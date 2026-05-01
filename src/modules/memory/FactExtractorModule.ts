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

const ConfigSchema = z.object({
  /** Max facts to extract per chunk */
  maxFactsPerChunk: z.number().default(8),
});

type FactExtractorConfig = z.infer<typeof ConfigSchema>;

export class FactExtractorModule implements BaseModule<FactExtractorConfig> {
  readonly name = "FactExtractor";
  readonly version = "0.2.0";
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

    for (const chunk of chunks) {
      try {
        const { messages } = loadAndRender("simplemem/extraction", {
          content: chunk.pageContent.substring(0, 2000),
        });

        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
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
        } catch {
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
            metadata: {
              source: chunk.metadata?.source ?? "extraction",
              importance: fact.importance ?? 0.7,
              confidence: 0.8,
            },
          });
        }
      } catch {
        // Fallback: treat the entire chunk as a single fact
        let embedding: number[] = [];
        try {
          embedding = await embedder.embedQuery(chunk.pageContent.substring(0, 500));
        } catch { /* no embedding available */ }

        newUnits.push({
          id: uuid(),
          content: chunk.pageContent.substring(0, 500),
          embedding,
          timestamp: new Date(),
          type: "fact",
          metadata: { source: "fallback-extraction" },
        });
      }
    }

    ctx.logger.info(`FactExtractor: Extracted ${newUnits.length} facts from ${chunks.length} chunks`);

    return {
      data: { memoryUnits: [...existing, ...newUnits] },
      metrics: { extracted: newUnits.length, chunks: chunks.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
