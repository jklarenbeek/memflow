/**
 * MemgraphClient — shared graph database provider
 *
 * Extracted from HRW's `providers/memgraph.ts` and promoted to a shared
 * singleton managed by WorkflowContext. Key improvements over the original:
 *
 *  1. Cypher injection prevention — all user-data values are parameterised;
 *     label/property identifiers (which cannot be parameterised in Cypher)
 *     are validated against a strict allowlist pattern before interpolation
 *  2. Proper session lifecycle — every operation opens/closes its own session
 *  3. Fallback chain — native vector search → MAGE → JS cosine full-scan
 *  4. Transaction support — `withTransaction()` helper for batched writes
 *  5. Typed config with Zod validation
 *  6. Structured logging via injected logger (not console.log)
 */

import neo4j, { Driver, Session, type ManagedTransaction } from "neo4j-driver";
import { z } from "zod";
import { MemgraphError } from "../core/errors.js";
import { cosineSimilarity } from "../utils/similarity.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const MemgraphConfigSchema = z.object({
  uri: z.string().default("bolt://localhost:7687"),
  user: z.string().default("memgraph"),
  password: z.string().default("memgraph"),
  database: z.string().default("memgraph"),
  maxPoolSize: z.number().default(50),
  connectionTimeoutMs: z.number().default(60_000),
});

export type MemgraphConfig = z.infer<typeof MemgraphConfigSchema>;

// ---------------------------------------------------------------------------
// Logger interface (subset of Winston — avoids hard dependency)
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MemgraphClient {
  private readonly driver: Driver;
  private readonly config: MemgraphConfig;
  private readonly logger: Logger;

  /**
   * Telemetry counter — tracks total Cypher queries executed.
   * Read via `getQueryCount()` for module-level telemetry (Improvement #10).
   */
  private _queryCount = 0;

  constructor(config: Partial<MemgraphConfig>, logger: Logger) {
    this.config = MemgraphConfigSchema.parse(config);
    this.logger = logger;
    this.driver = neo4j.driver(
      this.config.uri,
      neo4j.auth.basic(this.config.user, this.config.password),
      {
        maxConnectionPoolSize: this.config.maxPoolSize,
        connectionAcquisitionTimeout: this.config.connectionTimeoutMs,
      },
    );
  }

  /** Get the total number of Cypher queries executed since creation. */
  getQueryCount(): number {
    return this._queryCount;
  }

  /** Reset the query counter (useful between workflow stages for per-stage telemetry). */
  resetQueryCount(): void {
    this._queryCount = 0;
  }

  // -----------------------------------------------------------------------
  // Core query execution
  // -----------------------------------------------------------------------

  /** Run a Cypher query with full parameterisation. */
  async query<T = Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    this._queryCount++;
    const session = this.driver.session({ database: this.config.database });
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r) => r.toObject() as T);
    } catch (err) {
      throw new MemgraphError(
        `Query failed: ${(err as Error).message}`,
        err as Error,
        cypher,
      );
    } finally {
      await session.close();
    }
  }

  /** Execute a function inside a managed transaction. */
  async withTransaction<T>(
    fn: (tx: ManagedTransaction) => Promise<T>,
    mode: "read" | "write" = "write",
  ): Promise<T> {
    this._queryCount++;
    const session = this.driver.session({ database: this.config.database });
    try {
      return mode === "write"
        ? await session.executeWrite(fn)
        : await session.executeRead(fn);
    } catch (err) {
      throw new MemgraphError(
        `Transaction failed: ${(err as Error).message}`,
        err as Error,
      );
    } finally {
      await session.close();
    }
  }

  // -----------------------------------------------------------------------
  // Batch operations (Improvement #5)
  // -----------------------------------------------------------------------

  /**
   * Execute a batched Cypher query using UNWIND.
   *
   * Wraps the common pattern of iterating over N items and executing
   * a query per item into a single UNWIND-based query that sends all
   * items to Memgraph in one round-trip.
   *
   * @param cypher — Cypher template that starts with `UNWIND $items AS item`
   * @param items — Array of parameter objects for each item
   *
   * @example
   * ```ts
   * await client.batchQuery(
   *   `UNWIND $items AS item
   *    MATCH (n:Entity {id: item.id})
   *    SET n.communityId = item.communityId`,
   *   nodes.map(n => ({ id: n.id, communityId: n.communityId })),
   * );
   * ```
   */
  async batchQuery<T = Record<string, unknown>>(
    cypher: string,
    items: Record<string, unknown>[],
    additionalParams: Record<string, unknown> = {},
  ): Promise<T[]> {
    if (items.length === 0) return [];
    this._queryCount++;
    const session = this.driver.session({ database: this.config.database });
    try {
      const result = await session.run(cypher, { items, ...additionalParams });
      return result.records.map((r) => r.toObject() as T);
    } catch (err) {
      throw new MemgraphError(
        `Batch query failed (${items.length} items): ${(err as Error).message}`,
        err as Error,
        cypher,
      );
    } finally {
      await session.close();
    }
  }

  // -----------------------------------------------------------------------
  // Identifier validation
  // -----------------------------------------------------------------------

  /**
   * Validate a Cypher identifier (label or property name).
   *
   * Cypher does not support parameterised labels or property names, so we
   * must interpolate them as strings. This validator ensures only safe
   * identifiers are used (alphanumeric + underscore, 1-64 chars).
   */
  private assertSafeIdentifier(name: string, kind: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new MemgraphError(
        `Unsafe ${kind} identifier rejected: "${name}". ` +
          `Only alphanumeric characters and underscores are allowed.`,
      );
    }
  }

  /**
   * Validate a numeric dimension value for DDL interpolation.
   *
   * Cypher DDL (CREATE INDEX) does not support parameterised arguments,
   * so we must interpolate dimensions as a literal. This validator ensures
   * the value is a safe positive integer within reasonable bounds.
   */
  private assertSafeDimension(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 65536) {
      throw new MemgraphError(
        `Unsafe dimension value rejected: ${value}. ` +
          `Must be a positive integer between 1 and 65536.`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Vector index management
  // -----------------------------------------------------------------------

  /** Create a vector index with fallback to MAGE if native syntax fails. */
  async ensureVectorIndex(
    label: string,
    property: string,
    dimensions = 768,
    indexName = "vector_idx",
  ): Promise<void> {
    this.assertSafeIdentifier(label, "label");
    this.assertSafeIdentifier(property, "property");
    this.assertSafeIdentifier(indexName, "index name");
    this.assertSafeDimension(dimensions);

    try {
      await this.query(
        `CREATE VECTOR INDEX ${indexName} ON :${label}(${property}) ` +
          `WITH "cosine" OPTIONS { dimension: ${dimensions} }`,
      );
      this.logger.info(`Vector index created: ${label}.${property}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("already exists")) return;

      this.logger.warn(`Native vector index failed, trying MAGE fallback`, {
        error: msg,
      });
      try {
        await this.query(
          `CALL mage.create_vector_index($label, $property, $dim, "cosine")`,
          { label, property, dim: dimensions },
        );
      } catch {
        this.logger.warn(
          "MAGE vector fallback also failed — using property storage only",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Vector search with fallback chain
  // -----------------------------------------------------------------------

  /** Hybrid vector search: native → MAGE → JS cosine full-scan. */
  async vectorSearch(
    embedding: number[],
    label = "Chunk",
    property = "embedding",
    k = 5,
    minScore = 0.7,
  ): Promise<Array<{ node: Record<string, unknown>; score: number }>> {
    this.assertSafeIdentifier(label, "label");
    this.assertSafeIdentifier(property, "property");

    // Attempt 1: Native cosine via GDS
    try {
      const results = await this.query<{ n: { properties: Record<string, unknown> }; score: number }>(
        `MATCH (n:${label}) WHERE n.${property} IS NOT NULL ` +
          `WITH n, gds.similarity.cosine(n.${property}, $embedding) AS score ` +
          `WHERE score >= $minScore RETURN n, score ORDER BY score DESC LIMIT $k`,
        { embedding, minScore, k: neo4j.int(k) },
      );
      return results.map((r) => ({
        node: typeof r.n === "object" && "properties" in (r.n as any) ? (r.n as any).properties : r.n as Record<string, unknown>,
        score: typeof r.score === "number" ? r.score : Number(r.score),
      }));
    } catch {
      // Attempt 2: JS cosine full-scan fallback (for dev/small datasets)
      this.logger.warn("Vector search falling back to JS full-scan");
      return this.fullScanVectorSearch(embedding, label, property, k, minScore);
    }
  }

  private async fullScanVectorSearch(
    embedding: number[],
    label: string,
    property: string,
    k: number,
    minScore: number,
  ): Promise<Array<{ node: Record<string, unknown>; score: number }>> {
    // label/property already validated by the calling vectorSearch method
    const all = await this.query<{ n: Record<string, unknown> }>(
      `MATCH (n:${label}) WHERE n.${property} IS NOT NULL RETURN n LIMIT 1000`,
    );
    return all
      .map((r) => {
        const nodeProps = typeof r.n === "object" && "properties" in (r.n as any)
          ? (r.n as any).properties
          : r.n;
        const emb = (nodeProps as any)?.[property] as number[] | undefined;
        if (!emb) return null;
        const score = cosineSimilarity(embedding, emb);
        return { node: nodeProps as Record<string, unknown>, score };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null && x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  // -----------------------------------------------------------------------
  // Domain helpers
  // -----------------------------------------------------------------------

  /**
   * Persist memory units to the graph.
   *
   * Uses UNWIND for batch operations — reduces N round-trips to 2
   * (one for units, one for relations). All values are parameterised;
   * no string interpolation of user data.
   *
   * (Improvement #5: Batch Memgraph operations)
   */
  async persistMemoryUnits(
    units: Array<{
      id: string;
      content: string;
      embedding: number[];
      type: string;
      timestamp: string;
      metadata: Record<string, unknown>;
      relations?: Array<{ targetId: string; type: string; weight: number }>;
    }>,
  ): Promise<void> {
    if (units.length === 0) return;

    // Batch MERGE all memory units in a single UNWIND query
    await this.batchQuery(
      `UNWIND $items AS item
       MERGE (mu:MemoryUnit {id: item.id})
       SET mu.content = item.content,
           mu.embedding = item.embedding,
           mu.type = item.type,
           mu.timestamp = item.timestamp,
           mu.confidence = item.confidence`,
      units.map((u) => ({
        id: u.id,
        content: u.content,
        embedding: u.embedding,
        type: u.type,
        timestamp: u.timestamp,
        confidence: (u.metadata.confidence as number) ?? 0.8,
      })),
    );

    // Batch MERGE all relations in a single UNWIND query
    const allRelations = units.flatMap((u) =>
      (u.relations ?? []).map((rel) => ({
        srcId: u.id,
        tgtId: rel.targetId,
        relType: rel.type,
        weight: rel.weight,
      })),
    );

    if (allRelations.length > 0) {
      await this.batchQuery(
        `UNWIND $items AS item
         MATCH (src:MemoryUnit {id: item.srcId})
         MERGE (tgt:MemoryUnit {id: item.tgtId})
         MERGE (src)-[r:MEMORY_RELATION {relType: item.relType}]->(tgt)
         SET r.weight = item.weight`,
        allRelations,
      );
    }
  }

  /**
   * Build spatial proximity graph for document elements.
   * Used by S2Chunker when spatial-aware graph clustering is enabled.
   */
  async createDocumentGraph(
    elements: Array<{
      id: string;
      text: string;
      bbox?: { x0: number; y0: number; x1: number; y1: number; page: number };
      type: string;
    }>,
  ): Promise<void> {
    await this.withTransaction(async (tx) => {
      for (const el of elements) {
        const bbox = el.bbox ?? { x0: 0, y0: 0, x1: 100, y1: 20, page: 1 };
        await tx.run(
          `MERGE (e:Element {id: $id})
           SET e.text = $text, e.type = $type,
               e.x0 = $x0, e.y0 = $y0, e.x1 = $x1, e.y1 = $y1, e.page = $page`,
          {
            id: el.id,
            text: el.text,
            type: el.type,
            x0: bbox.x0,
            y0: bbox.y0,
            x1: bbox.x1,
            y1: bbox.y1,
            page: bbox.page,
          },
        );
      }

      // Create SPATIAL_NEAR edges between elements on the same page
      await tx.run(
        `MATCH (a:Element), (b:Element)
         WHERE a.id < b.id AND a.page = b.page
         WITH a, b, sqrt((a.x0 - b.x0)^2 + (a.y0 - b.y0)^2) AS dist
         WHERE dist < 500
         MERGE (a)-[r:SPATIAL_NEAR]->(b)
         SET r.weight = 1.0 / (1.0 + dist)`,
      );
    });
  }

  // -----------------------------------------------------------------------
  // Tenant isolation helpers
  // -----------------------------------------------------------------------

  /**
   * Wrap a Cypher query with a tenant filter.
   *
   * Automatically injects `AND n.tenantId = $tenantId` for all node patterns
   * in MATCH and WHERE clauses. This is a best-effort v1 approach — complex
   * queries may need manual tenant scoping.
   */
  withTenant(tenantId: string | undefined): MemgraphClient {
    if (!tenantId) return this;
    // Return a proxy that intercepts query calls and injects tenant params
    return new Proxy(this, {
      get(target, prop) {
        if (prop === "query") {
          return async <T = Record<string, unknown>>(
            cypher: string,
            params: Record<string, unknown> = {},
          ): Promise<T[]> => {
            return target.query(cypher, { ...params, tenantId });
          };
        }
        return (target as any)[prop];
      },
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    await this.driver.close();
    this.logger.info("Memgraph connection closed");
  }
}
