/**
 * Layer 1 — Infrastructure Validation
 *
 * Confirms services are alive and correctly configured before running
 * expensive integration tests. These tests are the gatekeeper: if they
 * fail, later layers are skipped automatically via describe.skipIf().
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  checkServiceHealth,
  invalidateHealthCache,
  LLM_TIMEOUT,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";
import { createLLM } from "../../../providers/LLMProvider.js";
import { createEmbeddings } from "../../../providers/EmbeddingProvider.js";

let health: Awaited<ReturnType<typeof checkServiceHealth>>;

describe("Infrastructure Health", () => {
  beforeAll(async () => {
    invalidateHealthCache();
    health = await checkServiceHealth();
  });

  // -------------------------------------------------------------------------
  // Memgraph
  // -------------------------------------------------------------------------

  test(
    "Memgraph bolt connection responds",
    async () => {
      const mg = new MemgraphClient(
        {
          uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
          user: process.env.MEMGRAPH_USER ?? "memgraph",
          password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      );
      const result = await mg.query("RETURN 1 AS n");
      await mg.close();
      expect(result).toHaveLength(1);
      expect(Number((result[0] as any).n)).toBe(1);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "MAGE vector similarity procedures are available (or JS fallback works)",
    async () => {
      const mg = new MemgraphClient(
        {
          uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
          user: process.env.MEMGRAPH_USER ?? "memgraph",
          password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      );
      // Check if MAGE has node_similarity.cosine OR vector_search.search
      const procs = await mg.query<{ name: string }>(
        `CALL mg.procedures() YIELD name RETURN name`,
      );
      const names = procs.map((p) => p.name);
      const hasNodeSimilarity = names.includes("node_similarity.cosine");
      const hasVectorSearch = names.includes("vector_search.search");

      if (hasNodeSimilarity || hasVectorSearch) {
        expect(true).toBe(true); // At least one vector procedure available
      } else {
        // Verify JS fallback is functional by calling vectorSearch directly
        await mg.query(
          `MERGE (c:__TestVec {id: 'a'}) SET c.embedding = [1.0, 0.0]`,
        );
        const results = await mg.vectorSearch(
          [1.0, 0.0],
          "__TestVec",
          "embedding",
          1,
          0.0,
        );
        await mg.query(`MATCH (c:__TestVec) DETACH DELETE c`);
        expect(results.length).toBeGreaterThan(0);
      }
      await mg.close();
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "MAGE community_detection.get is callable",
    async () => {
      const mg = new MemgraphClient(
        {
          uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
          user: process.env.MEMGRAPH_USER ?? "memgraph",
          password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      );
      // Create a tiny graph so the procedure has something to work with
      await mg.query(`
        CREATE (:__TestNode {id: 'a'})-[:__TEST_REL]->(:__TestNode {id: 'b'})
      `);
      const result = await mg.query(`
        CALL community_detection.get() YIELD node, community_id
        RETURN count(*) AS cnt
      `);
      await mg.query(`MATCH (n:__TestNode) DETACH DELETE n`);
      await mg.close();
      expect(result).toHaveLength(1);
      expect(Number((result[0] as any).cnt)).toBeGreaterThanOrEqual(0);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "Native vector index can be created (or already exists)",
    async () => {
      const mg = new MemgraphClient(
        {
          uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
          user: process.env.MEMGRAPH_USER ?? "memgraph",
          password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      );
      // This should succeed or silently return if already exists
      await mg.ensureVectorIndex("__TestChunk", "embedding", 768, "__test_vec_idx");
      // Verify index exists by trying a vector search
      const results = await mg.vectorSearch(
        Array.from({ length: 768 }, () => 0.01),
        "__TestChunk",
        "embedding",
        1,
        0.0,
      );
      await mg.query(`MATCH (n:__TestChunk) DETACH DELETE n`);
      await mg.query(`DROP VECTOR INDEX __test_vec_idx`);
      await mg.close();
      expect(Array.isArray(results)).toBe(true);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Ollama
  // -------------------------------------------------------------------------

  test(
    "Ollama is reachable and lists models",
    async () => {
      const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      expect(res.ok).toBe(true);
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      expect(data.models).toBeDefined();
      expect(data.models!.length).toBeGreaterThan(0);
    },
    { timeout: 10_000 },
  );

  test(
    "LLM model is available",
    () => {
      expect(health.llmModel).toBe(true);
    },
    { timeout: 5_000 },
  );

  test(
    "Embedding model is available",
    () => {
      expect(health.embeddingModel).toBe(true);
    },
    { timeout: 5_000 },
  );

  test(
    "Ollama generate smoke test",
    async () => {
      const llm = createLLM({
        provider: "ollama",
        model: process.env.LLM_MODEL ?? "qwen3.5:4b",
        temperature: 0,
        maxTokens: 10,
      });
      const resp = await llm.invoke([{ role: "user", content: "Say hi" }]);
      const text = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
      expect(text.length).toBeGreaterThan(0);
    },
    { timeout: LLM_TIMEOUT },
  );

  test(
    "Ollama embedding smoke test",
    async () => {
      const emb = createEmbeddings({
        provider: "ollama",
        model: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
      });
      const vec = await emb.embedQuery("hello world");
      expect(vec).toBeInstanceOf(Array);
      expect(vec.length).toBe(768);
    },
    { timeout: LLM_TIMEOUT },
  );
});
