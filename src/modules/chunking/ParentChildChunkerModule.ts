/**
 * ParentChildChunkerModule — PriHA parent-child chunk architecture
 *
 * Implements a two-tier chunking strategy where:
 * - **Child chunks** (small, ~200 tokens): Used for retrieval (high precision)
 * - **Parent chunks** (large, ~1000 tokens): Returned for context (high recall)
 *
 * During ingestion, both sizes are created and linked:
 *   :ChildChunk -[:BELONGS_TO]-> :ParentChunk
 *
 * During retrieval, the system searches child chunks for precision,
 * then returns the parent chunks for full context — combining the
 * benefits of fine-grained matching with broad context windows.
 *
 * Reads:  chunks (string[] | Chunk[])
 * Writes: parentChunks, childChunks, chunkRelations
 */

import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Target size for child chunks (tokens) */
  childChunkSize: z.number().default(200),
  /** Target size for parent chunks (tokens) */
  parentChunkSize: z.number().default(1000),
  /** Overlap between adjacent child chunks (tokens) */
  childOverlapTokens: z.number().default(30),
  /** Overlap between adjacent parent chunks (tokens) */
  parentOverlapTokens: z.number().default(100),
  /** Approximate chars per token for size estimation */
  charsPerToken: z.number().default(4),
  /** Whether to persist the parent-child relationships to Memgraph */
  persistToGraph: z.boolean().default(true),
});

type ParentChildConfig = z.infer<typeof ConfigSchema>;

interface ChunkOutput {
  id: string;
  text: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
}

interface ChunkRelation {
  childId: string;
  parentId: string;
}

export class ParentChildChunkerModule implements BaseModule<ParentChildConfig> {
  readonly name = "ParentChildChunker";
  readonly version = "0.5.0";
  private config: ParentChildConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<ParentChildConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const rawChunks = (input.data.chunks ?? []) as Array<string | { pageContent: string; metadata?: Record<string, unknown> }>;

    if (rawChunks.length === 0) {
      return {
        data: { parentChunks: [], childChunks: [], chunkRelations: [] },
        metrics: { parents: 0, children: 0 },
      };
    }

    // Normalize input to text array
    const texts = rawChunks.map((c) =>
      typeof c === "string" ? c : c.pageContent,
    );
    const fullText = texts.join("\n\n");

    // Create parent chunks (large, for context)
    const parentChunks = this.splitIntoChunks(
      fullText,
      this.config.parentChunkSize,
      this.config.parentOverlapTokens,
      "parent",
    );

    // Create child chunks (small, for retrieval precision)
    const childChunks: ChunkOutput[] = [];
    const relations: ChunkRelation[] = [];

    for (const parent of parentChunks) {
      const children = this.splitIntoChunks(
        parent.text,
        this.config.childChunkSize,
        this.config.childOverlapTokens,
        "child",
      );

      for (const child of children) {
        child.metadata = {
          ...child.metadata,
          parentId: parent.id,
        };
        childChunks.push(child);
        relations.push({ childId: child.id, parentId: parent.id });
      }
    }

    // Persist to Memgraph if configured
    if (this.config.persistToGraph) {
      await this.persistToGraph(parentChunks, childChunks, relations, ctx);
    }

    ctx.logger.info(
      `ParentChildChunker: ${parentChunks.length} parents, ${childChunks.length} children, ${relations.length} relations`,
    );

    return {
      data: {
        parentChunks,
        childChunks,
        chunkRelations: relations,
        // Also provide flat chunks list for downstream compatibility
        chunks: childChunks.map((c) => ({
          pageContent: c.text,
          metadata: c.metadata,
        })),
      },
      metrics: {
        parents: parentChunks.length,
        children: childChunks.length,
        relations: relations.length,
      },
    };
  }

  /**
   * Split text into chunks of approximately `targetTokens` size
   * with `overlapTokens` overlap between adjacent chunks.
   */
  private splitIntoChunks(
    text: string,
    targetTokens: number,
    overlapTokens: number,
    type: "parent" | "child",
  ): ChunkOutput[] {
    const targetChars = targetTokens * this.config.charsPerToken;
    const overlapChars = overlapTokens * this.config.charsPerToken;
    const chunks: ChunkOutput[] = [];

    if (text.length <= targetChars) {
      chunks.push({
        id: uuid(),
        text,
        tokenEstimate: Math.ceil(text.length / this.config.charsPerToken),
        metadata: { chunkType: type, index: 0 },
      });
      return chunks;
    }

    let start = 0;
    let index = 0;

    while (start < text.length) {
      let end = Math.min(start + targetChars, text.length);

      // Try to break at a sentence/paragraph boundary
      if (end < text.length) {
        const breakSearch = text.substring(end - 100, end + 100);
        const breakMatch = breakSearch.match(/[.!?\n]\s/);
        if (breakMatch && breakMatch.index !== undefined) {
          end = end - 100 + breakMatch.index + breakMatch[0].length;
        }
      }

      const chunkText = text.substring(start, end).trim();
      if (chunkText.length > 0) {
        chunks.push({
          id: uuid(),
          text: chunkText,
          tokenEstimate: Math.ceil(chunkText.length / this.config.charsPerToken),
          metadata: { chunkType: type, index },
        });
        index++;
      }

      start = end - overlapChars;
      if (start >= text.length - overlapChars) break;
    }

    return chunks;
  }

  /**
   * Persist parent-child chunk structure to Memgraph.
   * Creates :ParentChunk and :ChildChunk nodes with :BELONGS_TO edges.
   *
   * Uses UNWIND batch operations to reduce N round-trips to 2 (Improvement #5).
   */
  private async persistToGraph(
    parents: ChunkOutput[],
    children: ChunkOutput[],
    _relations: ChunkRelation[],
    ctx: WorkflowContext,
  ): Promise<void> {
    try {
      // Batch create parent chunks with single UNWIND query
      await ctx.memgraph.batchQuery(
        `UNWIND $items AS item
         CREATE (p:ParentChunk {id: item.id, text: item.text, tokenEstimate: item.tokens})`,
        parents.map((p) => ({ id: p.id, text: p.text, tokens: p.tokenEstimate })),
      );

      // Batch create child chunks and relations with single UNWIND query
      await ctx.memgraph.batchQuery(
        `UNWIND $items AS item
         CREATE (c:ChildChunk {id: item.childId, text: item.text, tokenEstimate: item.tokens})
         WITH c, item
         MATCH (p:ParentChunk {id: item.parentId})
         CREATE (c)-[:BELONGS_TO]->(p)`,
        children.map((c) => ({
          childId: c.id,
          text: c.text,
          tokens: c.tokenEstimate,
          parentId: (c.metadata as Record<string, unknown>).parentId,
        })),
      );

      ctx.logger.debug(`ParentChildChunker: persisted ${parents.length} parents, ${children.length} children to Memgraph`);
    } catch (err) {
      // Improvement #6: structured error logging instead of bare catch
      ctx.logger.warn(
        "ParentChildChunker: Memgraph batch persistence failed, continuing without graph",
        { error: (err as Error).message, parents: parents.length, children: children.length },
      );
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
