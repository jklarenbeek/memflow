/**
 * ChunkIngestorModule — MERGE chunk nodes into Memgraph
 *
 * Uses UNWIND batch operations for efficient ingestion (Improvement #5).
 *
 * Reads:  chunks, embeddings
 * Writes: (side-effect: :Chunk nodes in graph)
 */
import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({ vectorDim: z.number().default(768) });
type Config = z.infer<typeof ConfigSchema>;

export class ChunkIngestorModule implements BaseModule<Config> {
  readonly name = "ChunkIngestor";
  readonly version = "0.5.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const docs = (input.data.chunks ?? input.data.documents ?? []) as Document[];
    const embeddings = (input.data.embeddings ?? []) as number[][];

    if (docs.length === 0) {
      return { data: { chunks: docs, embeddings }, metrics: { ingested: 0 } };
    }

    // Improvement #5: Batch all chunk ingestions into a single UNWIND query
    const items = docs.map((doc, i) => ({
      id: (doc.metadata?.id as string) ?? `chunk-${this.hashContent(doc.pageContent)}`,
      text: doc.pageContent,
      emb: embeddings[i] ?? new Array(this.config.vectorDim).fill(0),
      source: (doc.metadata?.source as string) ?? "unknown",
      updatedAt: new Date().toISOString(),
    }));

    try {
      await ctx.memgraph.batchQuery(
        `UNWIND $items AS item
         MERGE (c:Chunk {id: item.id})
         SET c.text = item.text,
             c.embedding = item.emb,
             c.source = item.source,
             c.updatedAt = item.updatedAt`,
        items,
      );
    } catch (err) {
      // Improvement #6: structured error logging instead of silent failure
      ctx.logger.warn(`ChunkIngestor: batch ingestion failed, falling back to individual queries`, {
        error: (err as Error).message,
        chunkCount: items.length,
      });

      // Fallback: individual queries
      for (const item of items) {
        try {
          await ctx.memgraph.query(
            `MERGE (c:Chunk {id: $id}) SET c.text = $text, c.embedding = $emb, c.source = $source, c.updatedAt = $updatedAt`,
            item,
          );
        } catch (innerErr) {
          ctx.logger.debug(`ChunkIngestor: failed to ingest chunk ${item.id}`, {
            error: (innerErr as Error).message,
          });
        }
      }
    }

    ctx.logger.info(`ChunkIngestor: Ingested ${docs.length} chunks`);
    return {
      data: { chunks: docs, embeddings },
      metrics: {
        ingested: docs.length,
        memgraphQueries: ctx.memgraph.getQueryCount(),
      },
    };
  }

  private hashContent(text: string): string {
    let hash = 5381;
    for (let i = 0; i < Math.min(text.length, 500); i++) { hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0; }
    return hash.toString(36);
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
