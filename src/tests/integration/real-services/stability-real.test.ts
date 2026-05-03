/**
 * Layer 7 — Stability & Stress Tests
 *
 * Proves the system remains stable under load, repeated use, and
 * adverse conditions.
 *
 * NOTE: Stress tests involving multiple concurrent LLM calls are
 * marked as todo on CPU because qwen3.5:4b cannot handle parallel
 * load efficiently and each call takes 2–5 min.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  checkServiceHealth,
  cleanupTestData,
  createRealContext,
  LLM_TIMEOUT,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import { WorkflowContext } from "../../../core/WorkflowContext.js";
import { WorkflowEngine } from "../../../core/WorkflowEngine.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";

const servicesHealthy = await checkServiceHealth();

// Create a fresh context per test because WorkflowEngine.shutdown()
// closes the underlying MemgraphClient pool.
async function withFreshCtx<T>(fn: (ctx: WorkflowContext) => Promise<T>): Promise<T> {
  const ctx = await createRealContext();
  try {
    return await fn(ctx);
  } finally {
    await cleanupTestData(ctx.memgraph);
    await ctx.shutdown();
  }
}

describe.skipIf(!servicesHealthy.memgraph)("Stability & Stress (real services)", () => {
  afterAll(async () => {
    const ctx = await createRealContext();
    await cleanupTestData(ctx.memgraph);
    await ctx.shutdown();
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  test(
    "repeated ingestion does not create duplicate nodes (MERGE idempotency)",
    async () => {
      await withFreshCtx(async (ctx) => {
        const chunk = {
          id: "__test__idempotent",
          text: "This chunk should only exist once.",
          emb: Array.from({ length: 768 }, () => 0.01),
        };

        for (let i = 0; i < 10; i++) {
          await ctx.memgraph.batchQuery(
            `UNWIND $items AS item MERGE (c:Chunk {id: item.id}) SET c.text = item.text, c.embedding = item.emb`,
            [chunk],
          );
        }

        const result = await ctx.memgraph.query(
          `MATCH (c:Chunk {id: '__test__idempotent'}) RETURN count(c) AS cnt`,
        );
        expect(Number((result[0] as any).cnt)).toBe(1);
      });
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Concurrency (no engine shutdown — direct Memgraph batch writes)
  // -------------------------------------------------------------------------

  test(
    "5 concurrent direct batch writes all succeed",
    async () => {
      await withFreshCtx(async (ctx) => {
        const promises = Array.from({ length: 5 }, (_, i) =>
          ctx.memgraph.batchQuery(
            `UNWIND $items AS item MERGE (c:Chunk {id: item.id}) SET c.text = item.text`,
            [
              { id: `__test__conc-direct-${i}-a`, text: "A" },
              { id: `__test__conc-direct-${i}-b`, text: "B" },
            ],
          ),
        );

        await Promise.all(promises);

        const result = await ctx.memgraph.query(
          `MATCH (c:Chunk) WHERE c.id STARTS WITH '__test__conc-direct' RETURN count(c) AS cnt`,
        );
        expect(Number((result[0] as any).cnt)).toBe(10);
      });
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Large batch
  // -------------------------------------------------------------------------

  test(
    "ingesting 200 chunks in one batch succeeds",
    async () => {
      await withFreshCtx(async (ctx) => {
        const items = Array.from({ length: 200 }, (_, i) => ({
          id: `__test__large-${i}`,
          text: `This is chunk number ${i} for large batch ingestion testing.`,
          emb: Array.from({ length: 768 }, (_, j) => Math.sin(i + j) * 0.1),
        }));

        await ctx.memgraph.batchQuery(
          `UNWIND $items AS item MERGE (c:Chunk {id: item.id}) SET c.text = item.text, c.embedding = item.emb`,
          items,
        );

        const result = await ctx.memgraph.query(
          `MATCH (c:Chunk) WHERE c.id STARTS WITH '__test__large' RETURN count(c) AS cnt`,
        );
        expect(Number((result[0] as any).cnt)).toBe(200);
      });
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Resilience
  // -------------------------------------------------------------------------

  test(
    "MemgraphClient reconnects after close",
    async () => {
      const client = new MemgraphClient(
        {
          uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
          user: process.env.MEMGRAPH_USER ?? "memgraph",
          password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      );

      // First query
      const r1 = await client.query("RETURN 1 AS n");
      expect(Number((r1[0] as any).n)).toBe(1);

      // Close
      await client.close();

      // Reconnect with new client
      const client2 = new MemgraphClient(
        {
          uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
          user: process.env.MEMGRAPH_USER ?? "memgraph",
          password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      );
      const r2 = await client2.query("RETURN 2 AS n");
      expect(Number((r2[0] as any).n)).toBe(2);
      await client2.close();
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // LLM-heavy stability tests — todo on CPU
  // -------------------------------------------------------------------------

  test.todo("5 concurrent LLM workflows all succeed (slow on CPU — 15–25 min)");
  test.todo("full RAG round-trip: ingest → index → retrieve → generate × 3 (slow on CPU — 15–20 min)");
  test.todo("PatternComposer generates a valid workflow and it executes (slow on CPU — 5–10 min)");
});
