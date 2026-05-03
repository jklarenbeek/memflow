/**
 * retrieveEvidence — reusable evidence retrieval utility for GMPL modules
 *
 * Provides a unified interface for fetching evidence from the knowledge graph
 * and/or vector store. Designed to be consumed by any GMPL module that needs
 * evidence-backed responses (DebateModule, RedTeamModule, etc.).
 *
 * Retrieval modes:
 *   - "graph"  — Entity/relationship traversal via Cypher queries
 *   - "vector" — Cosine similarity search on Chunk embeddings
 *   - "hybrid" — Both graph and vector, merged and deduplicated
 *   - "none"   — No-op, returns empty evidence (default)
 *
 * @module gmpl/retrieveEvidence
 */

import type { WorkflowContext } from "../core/WorkflowContext.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvidenceRetrievalMode = "graph" | "vector" | "hybrid" | "none";

export interface EvidenceItem {
  /** Source of the evidence: "graph" or "vector" */
  source: "graph" | "vector";
  /** Evidence text content */
  content: string;
  /** Relevance score (0–1), where applicable */
  score: number;
  /** Additional metadata (entity type, relationship, chunk ID, etc.) */
  metadata: Record<string, unknown>;
}

export interface RetrievedEvidence {
  /** All retrieved evidence items, sorted by score descending */
  items: EvidenceItem[];
  /** Formatted text block suitable for prompt injection */
  formatted: string;
  /** Total number of items retrieved before any limit was applied */
  totalFound: number;
}

export interface RetrieveEvidenceOptions {
  /** Retrieval mode */
  mode: EvidenceRetrievalMode;
  /** The query to search for */
  query: string;
  /** Maximum number of evidence items to return (default: 8) */
  maxItems?: number;
  /** Maximum graph traversal hops (default: 2) */
  maxHops?: number;
  /** Minimum vector similarity threshold (default: 0.6) */
  minSimilarity?: number;
  /** Domain context for filtering (optional) */
  domainId?: string;
}

// ---------------------------------------------------------------------------
// Empty result constant
// ---------------------------------------------------------------------------

const EMPTY_EVIDENCE: RetrievedEvidence = Object.freeze({
  items: [],
  formatted: "",
  totalFound: 0,
});

// ---------------------------------------------------------------------------
// Main retrieval function
// ---------------------------------------------------------------------------

/**
 * Retrieve evidence from the knowledge graph and/or vector store.
 *
 * This utility is the canonical way for GMPL modules to augment their
 * prompts with evidence. It abstracts the underlying storage queries
 * and provides a consistent, formatted output.
 *
 * @param ctx  - WorkflowContext providing memgraph and logger access
 * @param opts - Retrieval options (mode, query, limits)
 * @returns    - Retrieved evidence with formatted text for prompt injection
 */
export async function retrieveEvidence(
  ctx: WorkflowContext,
  opts: RetrieveEvidenceOptions,
): Promise<RetrievedEvidence> {
  if (opts.mode === "none") return EMPTY_EVIDENCE;

  const maxItems = opts.maxItems ?? 8;
  const items: EvidenceItem[] = [];

  try {
    if (opts.mode === "graph" || opts.mode === "hybrid") {
      const graphItems = await retrieveFromGraph(ctx, opts);
      items.push(...graphItems);
    }

    if (opts.mode === "vector" || opts.mode === "hybrid") {
      const vectorItems = await retrieveFromVector(ctx, opts);
      items.push(...vectorItems);
    }
  } catch (err) {
    ctx.logger.warn(
      `retrieveEvidence: Retrieval failed (mode=${opts.mode}): ${(err as Error).message}`,
    );
    return EMPTY_EVIDENCE;
  }

  // Deduplicate by content hash (simple substring match for overlap)
  const deduplicated = deduplicateItems(items);

  // Sort by score descending and limit
  deduplicated.sort((a, b) => b.score - a.score);
  const limited = deduplicated.slice(0, maxItems);

  return {
    items: limited,
    formatted: formatEvidence(limited),
    totalFound: deduplicated.length,
  };
}

// ---------------------------------------------------------------------------
// Graph retrieval
// ---------------------------------------------------------------------------

async function retrieveFromGraph(
  ctx: WorkflowContext,
  opts: RetrieveEvidenceOptions,
): Promise<EvidenceItem[]> {
  const maxHops = opts.maxHops ?? 2;

  // Extract key terms from the query for entity matching
  const queryTerms = extractQueryTerms(opts.query);

  if (queryTerms.length === 0) return [];

  // Build a Cypher query that matches entities by name similarity
  // and traverses relationships up to maxHops depth
  const cypher = `
    MATCH (e:Entity)
    WHERE any(term IN $terms WHERE toLower(e.name) CONTAINS toLower(term))
    ${opts.domainId ? "AND (NOT exists(e.domainId) OR e.domainId = $domainId)" : ""}
    OPTIONAL MATCH path = (e)-[r*1..${maxHops}]-(related:Entity)
    WITH e, related, relationships(path) AS rels
    RETURN
      e.name AS entityName,
      e.type AS entityType,
      e.description AS entityDescription,
      related.name AS relatedName,
      related.type AS relatedType,
      related.description AS relatedDescription,
      [rel IN rels | type(rel)] AS relTypes
    LIMIT 20
  `;

  const results = await ctx.memgraph.query<{
    entityName: string;
    entityType: string;
    entityDescription: string;
    relatedName: string | null;
    relatedType: string | null;
    relatedDescription: string | null;
    relTypes: string[];
  }>(cypher, {
    terms: queryTerms,
    ...(opts.domainId && { domainId: opts.domainId }),
  });

  const items: EvidenceItem[] = [];

  for (const row of results) {
    // Primary entity
    items.push({
      source: "graph",
      content: `[${row.entityType}] ${row.entityName}: ${row.entityDescription ?? "No description"}`,
      score: 0.8, // Graph entities matched by term get high base score
      metadata: { entityName: row.entityName, entityType: row.entityType },
    });

    // Related entity (if traversal found one)
    if (row.relatedName && row.relatedDescription) {
      const relLabel = row.relTypes.length > 0 ? row.relTypes.join(" → ") : "RELATED_TO";
      items.push({
        source: "graph",
        content: `[${row.relatedType}] ${row.relatedName} (${relLabel} ${row.entityName}): ${row.relatedDescription}`,
        score: 0.6,
        metadata: {
          entityName: row.relatedName,
          entityType: row.relatedType,
          relationType: relLabel,
          parentEntity: row.entityName,
        },
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Vector retrieval
// ---------------------------------------------------------------------------

async function retrieveFromVector(
  ctx: WorkflowContext,
  opts: RetrieveEvidenceOptions,
): Promise<EvidenceItem[]> {
  const minSimilarity = opts.minSimilarity ?? 0.6;
  const limit = opts.maxItems ?? 8;

  // Use the WorkflowContext's embedding provider to generate query embedding
  const embeddings = ctx.getEmbeddings();
  const [queryEmbedding] = await embeddings.embedDocuments([opts.query]);

  if (!queryEmbedding || queryEmbedding.length === 0) return [];

  // Query Memgraph for vector similarity on Chunk nodes
  const cypher = `
    CALL vector_search.search("chunk_embeddings", $limit, $queryVector)
    YIELD node, similarity
    WHERE similarity >= $minSimilarity
    ${opts.domainId ? "AND (NOT exists(node.domainId) OR node.domainId = $domainId)" : ""}
    RETURN
      node.content AS content,
      node.id AS chunkId,
      node.source AS source,
      similarity AS score
    ORDER BY similarity DESC
    LIMIT $limit
  `;

  try {
    const results = await ctx.memgraph.query<{
      content: string;
      chunkId: string;
      source: string;
      score: number;
    }>(cypher, {
      queryVector: queryEmbedding,
      minSimilarity,
      limit,
      ...(opts.domainId && { domainId: opts.domainId }),
    });

    return results.map((row) => ({
      source: "vector" as const,
      content: row.content,
      score: row.score,
      metadata: { chunkId: row.chunkId, originalSource: row.source },
    }));
  } catch (err) {
    // Fallback: vector_search may not be available in all Memgraph configurations
    ctx.logger.debug(
      `retrieveEvidence: Vector search not available, falling back to text match: ${(err as Error).message}`,
    );

    // Fallback to simple text-based retrieval on Chunk nodes
    const fallbackCypher = `
      MATCH (c:Chunk)
      WHERE toLower(c.content) CONTAINS toLower($query)
      RETURN c.content AS content, c.id AS chunkId, c.source AS source
      LIMIT $limit
    `;

    const fallbackResults = await ctx.memgraph.query<{
      content: string;
      chunkId: string;
      source: string;
    }>(fallbackCypher, { query: opts.query.substring(0, 100), limit });

    return fallbackResults.map((row, i) => ({
      source: "vector" as const,
      content: row.content,
      score: 0.5 - i * 0.02, // Decreasing score for text matches
      metadata: { chunkId: row.chunkId, originalSource: row.source, fallback: true },
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract meaningful search terms from a query string.
 * Filters out stop words and very short terms.
 */
function extractQueryTerms(query: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "shall", "may", "might", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "about",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more", "most",
    "other", "some", "such", "than", "too", "very", "just", "how",
    "what", "which", "who", "whom", "this", "that", "these", "those",
    "it", "its", "my", "your", "his", "her", "our", "their",
  ]);

  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

/**
 * Deduplicate evidence items by detecting content overlap.
 * Uses a simple substring containment check.
 */
function deduplicateItems(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const result: EvidenceItem[] = [];

  for (const item of items) {
    // Normalize content for dedup: lowercase, trim whitespace
    const normalized = item.content.toLowerCase().trim().substring(0, 200);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(item);
    }
  }

  return result;
}

/**
 * Format evidence items into a text block suitable for LLM prompt injection.
 */
function formatEvidence(items: EvidenceItem[]): string {
  if (items.length === 0) return "";

  const lines = items.map(
    (item, i) =>
      `[${i + 1}] (${item.source}, score: ${item.score.toFixed(2)}) ${item.content}`,
  );

  return `Evidence:\n${lines.join("\n")}`;
}
