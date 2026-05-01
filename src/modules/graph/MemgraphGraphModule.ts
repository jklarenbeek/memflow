/**
 * MemgraphGraphModule — LLM-driven graph-based text indexing
 *
 * Implements the LightRAG paper's core graph indexing pipeline (§3.1):
 *
 *  1. Entity & Relationship Extraction: LLM-driven extraction from chunks
 *  2. Entity Profiling: summarize entities across all mention contexts
 *  3. Deduplication: merge equivalent entity references
 *  4. Graph Persistence: MERGE-based upserts to Memgraph
 *  5. Community Detection: MAGE Leiden algorithm for topic clusters
 *  6. Hybrid Search: vector + graph traversal for retrieval
 *
 * All LLM prompts are loaded from TOML files in src/prompts/graph/.
 *
 * Supports incremental graph updates via:
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
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  vectorDim: z.number().default(768),
  useMAGE: z.boolean().default(true),
  /** Max chunks to process with LLM entity extraction per batch */
  maxChunksForExtraction: z.number().default(50),
  /** Enable LLM-driven deduplication */
  enableDeduplication: z.boolean().default(true),
  /** Enable LLM-driven entity profiling */
  enableProfiling: z.boolean().default(true),
});

type GraphConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}

interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  description: string;
  keywords: string[];
}

export class MemgraphGraphModule implements BaseModule<GraphConfig> {
  readonly name = "MemgraphGraph";
  readonly version = "0.2.0";
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

    // 2. LLM-driven entity & relationship extraction (LightRAG paper §3.1)
    const chunksToProcess = docs.slice(0, this.config.maxChunksForExtraction);
    const allEntities: ExtractedEntity[] = [];
    const allRelationships: ExtractedRelationship[] = [];

    for (const doc of chunksToProcess) {
      try {
        const { entities, relationships } = await this.extractEntitiesAndRelations(
          doc.pageContent,
          ctx,
        );
        allEntities.push(...entities);
        allRelationships.push(...relationships);
      } catch (err) {
        ctx.logger.debug(
          `Entity extraction failed for chunk: ${(err as Error).message}`,
        );
      }
    }

    ctx.logger.info(
      `MemgraphGraph: Extracted ${allEntities.length} entities, ${allRelationships.length} relationships`,
    );

    // 3. Deduplication — merge equivalent entity references
    const deduplicatedEntities = this.config.enableDeduplication
      ? await this.deduplicateEntities(allEntities, ctx)
      : allEntities;

    // 4. Persist entities and relationships to graph
    for (const entity of deduplicatedEntities) {
      await memgraph.query(
        `MERGE (e:Entity {name: $name})
         SET e.type = $type, e.description = $description,
             e.updatedAt = $updatedAt`,
        {
          name: entity.name,
          type: entity.type,
          description: entity.description,
          updatedAt: new Date().toISOString(),
        },
      );
    }

    // Link entities to their source chunks
    for (const doc of chunksToProcess) {
      const chunkId =
        (doc.metadata?.id as string) ??
        `chunk-${this.hashContent(doc.pageContent)}`;
      for (const entity of deduplicatedEntities) {
        if (doc.pageContent.toLowerCase().includes(entity.name.toLowerCase())) {
          await memgraph.query(
            `MATCH (c:Chunk {id: $chunkId}), (e:Entity {name: $entityName})
             MERGE (c)-[:MENTIONS]->(e)`,
            { chunkId, entityName: entity.name },
          );
        }
      }
    }

    // Persist relationships
    for (const rel of allRelationships) {
      await memgraph.query(
        `MERGE (s:Entity {name: $source})
         MERGE (t:Entity {name: $target})
         MERGE (s)-[r:RELATES_TO {type: $relType}]->(t)
         SET r.description = $description, r.keywords = $keywords`,
        {
          source: rel.source,
          target: rel.target,
          relType: rel.type,
          description: rel.description,
          keywords: rel.keywords,
        },
      );
    }

    // 5. Entity profiling — generate key-value summaries
    if (this.config.enableProfiling && deduplicatedEntities.length > 0) {
      await this.profileEntities(deduplicatedEntities, chunksToProcess, ctx, memgraph);
    }

    // 6. Community detection via MAGE
    if (this.config.useMAGE) {
      try {
        await memgraph.query(
          `CALL mage.community_leiden("Entity", "RELATES_TO", {max_iterations: 10}) YIELD *`,
        );
      } catch {
        ctx.logger.debug("MAGE community detection not available");
      }
    }

    // 7. Hybrid search to prepare context
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
        entitiesExtracted: deduplicatedEntities.length,
        relationshipsExtracted: allRelationships.length,
        retrievalHits: 5,
      },
    };
  }

  // -----------------------------------------------------------------------
  // LLM-driven entity & relationship extraction (LightRAG paper §3.1)
  // -----------------------------------------------------------------------

  private async extractEntitiesAndRelations(
    chunkText: string,
    ctx: WorkflowContext,
  ): Promise<{ entities: ExtractedEntity[]; relationships: ExtractedRelationship[] }> {
    const llm = ctx.getLLM();
    const { messages } = loadAndRender("graph/entity_extraction", {
      chunk_text: chunkText.substring(0, 2000),
    });

    const resp = await llm.invoke(messages);
    const text = typeof resp.content === "string" ? resp.content : "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    return {
      entities: (parsed.entities ?? []) as ExtractedEntity[],
      relationships: (parsed.relationships ?? []).map((r: Record<string, unknown>) => ({
        source: r.source ?? "",
        target: r.target ?? "",
        type: r.type ?? "RELATES_TO",
        description: r.description ?? "",
        keywords: (r.keywords ?? []) as string[],
      })) as ExtractedRelationship[],
    };
  }

  // -----------------------------------------------------------------------
  // Entity deduplication
  // -----------------------------------------------------------------------

  private async deduplicateEntities(
    entities: ExtractedEntity[],
    ctx: WorkflowContext,
  ): Promise<ExtractedEntity[]> {
    if (entities.length <= 1) return entities;

    const uniqueNames = [...new Set(entities.map((e) => e.name))];
    if (uniqueNames.length <= 1) return entities;

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("graph/deduplication", {
        entity_list: uniqueNames.join(", "),
      });

      const resp = await llm.invoke(messages);
      const text = typeof resp.content === "string" ? resp.content : "";
      const groups = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as string[][];

      // Build canonical name map
      const canonicalMap = new Map<string, string>();
      for (const group of groups) {
        if (group.length > 0) {
          const canonical = group[0]; // First name in group is canonical
          for (const name of group) {
            canonicalMap.set(name, canonical);
          }
        }
      }

      // Deduplicate entities using canonical names
      const seen = new Set<string>();
      const result: ExtractedEntity[] = [];
      for (const entity of entities) {
        const canonical = canonicalMap.get(entity.name) ?? entity.name;
        if (!seen.has(canonical)) {
          seen.add(canonical);
          result.push({ ...entity, name: canonical });
        }
      }

      ctx.logger.info(
        `MemgraphGraph: Deduplicated ${entities.length} → ${result.length} entities`,
      );
      return result;
    } catch {
      // Fallback: simple case-insensitive dedup
      const seen = new Map<string, ExtractedEntity>();
      for (const e of entities) {
        const key = e.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, e);
      }
      return [...seen.values()];
    }
  }

  // -----------------------------------------------------------------------
  // Entity profiling (LightRAG paper §3.1)
  // -----------------------------------------------------------------------

  private async profileEntities(
    entities: ExtractedEntity[],
    docs: Document[],
    ctx: WorkflowContext,
    memgraph: WorkflowContext["memgraph"],
  ): Promise<void> {
    const llm = ctx.getLLM();

    // Profile top entities (limit for token efficiency)
    for (const entity of entities.slice(0, 20)) {
      const relevantContexts = docs
        .filter((d) =>
          d.pageContent.toLowerCase().includes(entity.name.toLowerCase()),
        )
        .map((d) => d.pageContent.substring(0, 300))
        .slice(0, 5);

      if (relevantContexts.length === 0) continue;

      try {
        const { messages } = loadAndRender("graph/entity_profiling", {
          entity_name: entity.name,
          entity_type: entity.type,
          contexts: relevantContexts.join("\n---\n"),
        });

        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

        // Persist profile to graph
        await memgraph.query(
          `MATCH (e:Entity {name: $name})
           SET e.profileSummary = $summary, e.keyThemes = $themes`,
          {
            name: entity.name,
            summary: parsed.summary ?? "",
            themes: parsed.key_themes ?? [],
          },
        );
      } catch {
        // Profiling is optional
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

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