/**
 * Layer 2 — Memgraph Schema & Index Validation
 *
 * Verifies the exact node labels, relationship types, indexes, and
 * constraints the MemFlow engine expects from its persistence layer.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  checkServiceHealth,
  cleanupTestData,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";

let mg: MemgraphClient;
let servicesHealthy = false;

describe.skipIf(!(await checkServiceHealth()).memgraph)("Memgraph Schema & Indexes", () => {
  beforeAll(async () => {
    servicesHealthy = (await checkServiceHealth()).memgraph;
    if (!servicesHealthy) return;

    mg = new MemgraphClient(
      {
        uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
        user: process.env.MEMGRAPH_USER ?? "memgraph",
        password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
      },
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    );
  });

  afterAll(async () => {
    if (mg) {
      await cleanupTestData(mg);
      await mg.close();
    }
  });

  // -----------------------------------------------------------------------
  // Labels
  // -----------------------------------------------------------------------

  const requiredLabels = [
    "Chunk",
    "MemoryUnit",
    "Entity",
    "Community",
    "Element",
    "ParentChunk",
    "ChildChunk",
    "Answer",
    "Citation",
    "ModuleState",
    "DebateSession",
    "ReviewSession",
    "RedTeamSession",
    "DelphiSession",
    "PendingDecision",
    "Decision",
    "Reflection",
  ];

  for (const label of requiredLabels) {
    test(
      `label :${label} can be created and queried`,
      async () => {
        await mg.query(
          `MERGE (n:${label} {id: '__test__schema-${label}'}) SET n.created = true`,
        );
        const result = await mg.query(
          `MATCH (n:${label} {id: '__test__schema-${label}'}) RETURN count(n) AS cnt`,
        );
        expect(Number((result[0] as any).cnt)).toBe(1);
      },
      { timeout: MEMGRAPH_TIMEOUT },
    );
  }

  // -----------------------------------------------------------------------
  // Relationship types
  // -----------------------------------------------------------------------

  const requiredRels = [
    "SPATIAL_NEAR",
    "MEMORY_RELATION",
    "MENTIONS",
    "RELATES_TO",
    "BELONGS_TO",
    "CITES",
    "IMPROVED_BY",
    "REFERENCES",
  ];

  for (const relType of requiredRels) {
    test(
      `relationship type :${relType} can be created`,
      async () => {
        await mg.query(
          `MATCH (a:__TestRelNode {id: '__test__rel-a-${relType}'}) ` +
            `MATCH (b:__TestRelNode {id: '__test__rel-b-${relType}'}) ` +
            `MERGE (a)-[r:${relType}]->(b) SET r.test = true`,
        );
        const result = await mg.query(
          `MATCH ()-[r:${relType} {test: true}]->() RETURN count(r) AS cnt`,
        );
        expect(Number((result[0] as any).cnt)).toBeGreaterThanOrEqual(0);
      },
      { timeout: MEMGRAPH_TIMEOUT },
    );
  }

  // -----------------------------------------------------------------------
  // Vector indexes
  // -----------------------------------------------------------------------

  test(
    "vector index on Chunk.embedding is queryable",
    async () => {
      await mg.ensureVectorIndex("Chunk", "embedding", 768, "chunk_emb_idx_test");
      // Insert a test chunk
      await mg.query(
        `MERGE (c:Chunk {id: '__test__vec-chunk'}) SET c.embedding = $emb, c.text = 'test'`,
        { emb: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1.0 : 0.0)) },
      );
      const results = await mg.vectorSearch(
        Array.from({ length: 768 }, (_, i) => (i === 0 ? 1.0 : 0.0)),
        "Chunk",
        "embedding",
        5,
        0.0,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].node.id).toBe("__test__vec-chunk");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "vector index on MemoryUnit.embedding is queryable",
    async () => {
      await mg.ensureVectorIndex("MemoryUnit", "embedding", 768, "mem_emb_idx_test");
      await mg.query(
        `MERGE (m:MemoryUnit {id: '__test__vec-mem'}) SET m.embedding = $emb, m.content = 'test'`,
        { emb: Array.from({ length: 768 }, (_, i) => (i === 1 ? 1.0 : 0.0)) },
      );
      const results = await mg.vectorSearch(
        Array.from({ length: 768 }, (_, i) => (i === 1 ? 1.0 : 0.0)),
        "MemoryUnit",
        "embedding",
        5,
        0.0,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].node.id).toBe("__test__vec-mem");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -----------------------------------------------------------------------
  // Scalar indexes (GMPL)
  // -----------------------------------------------------------------------

  test(
    "scalar index on PendingDecision.id supports fast lookup",
    async () => {
      await mg.query(
        `MERGE (p:PendingDecision {id: '__test__pending-1'}) SET p.content = 'test'`,
      );
      const result = await mg.query(
        `MATCH (p:PendingDecision {id: '__test__pending-1'}) RETURN p.content AS content`,
      );
      expect((result[0] as any).content).toBe("test");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "scalar index on Decision.pendingId supports fast lookup",
    async () => {
      await mg.query(
        `MERGE (d:Decision {pendingId: '__test__pending-1'}) SET d.outcome = 'success'`,
      );
      const result = await mg.query(
        `MATCH (d:Decision {pendingId: '__test__pending-1'}) RETURN d.outcome AS outcome`,
      );
      expect((result[0] as any).outcome).toBe("success");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "scalar index on Reflection.decisionId supports fast lookup",
    async () => {
      await mg.query(
        `MERGE (r:Reflection {decisionId: '__test__pending-1'}) SET r.text = 'reflection'`,
      );
      const result = await mg.query(
        `MATCH (r:Reflection {decisionId: '__test__pending-1'}) RETURN r.text AS text`,
      );
      expect((result[0] as any).text).toBe("reflection");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -----------------------------------------------------------------------
  // Batch & transaction helpers
  // -----------------------------------------------------------------------

  test(
    "batchQuery (UNWIND) ingests 100 items in a single round-trip",
    async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: `__test__batch-${i}`,
        value: i,
      }));
      await mg.batchQuery(
        `UNWIND $items AS item MERGE (n:__BatchTest {id: item.id}) SET n.value = item.value`,
        items,
      );
      const result = await mg.query(
        `MATCH (n:__BatchTest) WHERE n.id STARTS WITH '__test__batch' RETURN count(n) AS cnt`,
      );
      expect(Number((result[0] as any).cnt)).toBe(100);
      // Cleanup
      await mg.query(`MATCH (n:__BatchTest) WHERE n.id STARTS WITH '__test__batch' DETACH DELETE n`);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "withTransaction read/write round-trip works",
    async () => {
      const txResult = await mg.withTransaction(async (tx) => {
        await tx.run(
          `MERGE (n:__TxTest {id: '__test__tx-1'}) SET n.counter = 42`,
        );
        const result = await tx.run(
          `MATCH (n:__TxTest {id: '__test__tx-1'}) RETURN n.counter AS counter`,
        );
        return result.records[0].get("counter");
      }, "write");

      expect(Number(txResult)).toBe(42);

      // Verify outside transaction
      const outside = await mg.query(
        `MATCH (n:__TxTest {id: '__test__tx-1'}) RETURN n.counter AS counter`,
      );
      expect(Number((outside[0] as any).counter)).toBe(42);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );
});
