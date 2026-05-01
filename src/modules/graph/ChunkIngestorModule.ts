/**
 * ChunkIngestorModule — MERGE chunk nodes into Memgraph
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
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const docs = (input.data.chunks ?? input.data.documents ?? []) as Document[];
    const embeddings = (input.data.embeddings ?? []) as number[][];

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const emb = embeddings[i] ?? new Array(this.config.vectorDim).fill(0);
      const chunkId = (doc.metadata?.id as string) ?? `chunk-${this.hashContent(doc.pageContent)}`;
      await ctx.memgraph.query(
        `MERGE (c:Chunk {id: $id}) SET c.text = $text, c.embedding = $emb, c.source = $source, c.updatedAt = $updatedAt`,
        { id: chunkId, text: doc.pageContent, emb, source: (doc.metadata?.source as string) ?? "unknown", updatedAt: new Date().toISOString() },
      );
    }
    ctx.logger.info(`ChunkIngestor: Ingested ${docs.length} chunks`);
    return { data: { chunks: docs, embeddings }, metrics: { ingested: docs.length } };
  }

  private hashContent(text: string): string {
    let hash = 5381;
    for (let i = 0; i < Math.min(text.length, 500); i++) { hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0; }
    return hash.toString(36);
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
