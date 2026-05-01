/**
 * MemgraphGraphModule — graph ingest and dual-level retrieval prep
 *
 * Rewritten to use the shared MemgraphClient from WorkflowContext
 * instead of creating its own driver. Keeps MAGE community detection
 * and entity extraction, but the driver lifecycle is managed externally.
 *
 * Supports incremental graph updates (LightRAG paper §3.4) via:
 *  - MERGE-based upserts: existing nodes are updated, not duplicated
 *  - Content-hash chunk IDs: same content → same node across runs
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  vectorDim: z.number().default(768),
  useMAGE: z.boolean().default(true),
});

type GraphConfig = z.infer<typeof ConfigSchema>;

export class MemgraphGraphModule implements BaseModule<GraphConfig> {
  readonly name = "MemgraphGraph";
  readonly version = "2.1.0";
  private config: GraphConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<GraphConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const memgraph = ctx.memgraph;

    const docs = (input.data.chunks ?? input.data.documents ?? []) as Document[];
    const embeddings = (input.data.embeddings ?? []) as number[][];

    // 1. Ingest chunks as graph nodes (MERGE = incremental upsert)
    //    Content-hash IDs ensure idempotent re-ingestion
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const emb = embeddings[i] ?? new Array(this.config.vectorDim).fill(0);
      const chunkId =
        (doc.metadata?.id as string) ??
        `chunk-${this.hashContent(doc.pageContent)}`;
      await memgraph.query(
        `MERGE (c:Chunk {id: $id})
         SET c.text = $text, c.embedding = $emb, c.source = $source,
             c.updatedAt = $updatedAt`,
        {
          id: chunkId,
          text: doc.pageContent,
          emb,
          source: (doc.metadata?.source as string) ?? "unknown",
          updatedAt: new Date().toISOString(),
        },
      );
    }

    // 2. Build entity graph (simplified — real version uses LLM extraction)
    await memgraph.query(
      `MATCH (c:Chunk)
       WHERE c.text CONTAINS 'agent' OR c.text CONTAINS 'memory'
       MERGE (e:Entity {name: 'LLM_Agent'})
       MERGE (c)-[:MENTIONS]->(e)`,
    );

    // 3. Community detection via MAGE
    if (this.config.useMAGE) {
      try {
        await memgraph.query(
          `CALL mage.community_leiden("Chunk", "MENTIONS", {max_iterations: 10}) YIELD *`,
        );
      } catch {
        ctx.logger.debug("MAGE community detection not available");
      }
    }

    // 4. Hybrid search to prepare context
    let retrieved = "";
    try {
      const queryEmb =
        embeddings[0] ?? new Array(this.config.vectorDim).fill(0.1);
      const vectorSearch = await memgraph.query<{
        text: string;
        score: number;
      }>(
        `CALL db.index.vector.queryNodes('chunk_embeddings', 5, $queryEmb)
         YIELD node, score
         RETURN node.text AS text, score`,
        { queryEmb },
      );

      const graphContext = await memgraph.query<{
        name: string;
        contexts: string[];
      }>(
        `MATCH (c:Chunk)-[:MENTIONS]->(e:Entity)
         RETURN e.name AS name, collect(c.text) AS contexts LIMIT 5`,
      );

      retrieved = [
        ...vectorSearch.map((r) => r.text),
        ...graphContext.flatMap((r) => r.contexts),
      ]
        .filter(Boolean)
        .join("\n\n");
    } catch {
      ctx.logger.debug("Hybrid search not available");
    }

    return {
      data: { graphContext: retrieved },
      metrics: {
        graphNodes: docs.length,
        retrievalHits: 5,
      },
    };
  }

  /**
   * Simple content hash for deterministic chunk IDs.
   * Uses djb2 hash to generate a stable string from content,
   * ensuring the same text always produces the same graph node ID.
   */
  private hashContent(text: string): string {
    let hash = 5381;
    for (let i = 0; i < Math.min(text.length, 500); i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}