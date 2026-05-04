/**
 * Layer 5 — Pipeline Integration
 *
 * Executes complete sub-workflows (JSON-described DAGs) with real services
 * to validate end-to-end pipeline behavior.
 *
 * NOTE: Full paper-aligned pipelines (SimpleMem, LightMem, PriHA, etc.)
 * involve 3–7 stages with multiple LLM calls. On CPU-only Ollama with
 * qwen3.5:4b each pipeline can take 10–20 min. We validate the sub-workflow
 * engine with a fast custom DAG and mark the LLM-heavy reference pipelines
 * as todo for GPU environments.
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  checkServiceHealth,
  cleanupTestData,
  createRealContext,
  LLM_TIMEOUT,
} from "./_setup.js";
import { WorkflowContext } from "../../../core/WorkflowContext.js";
import { WorkflowEngine } from "../../../core/WorkflowEngine.js";

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

describe.skipIf(!servicesHealthy.memgraph)("Pipeline Integration (real services)", () => {
  afterAll(async () => {
    // Global cleanup of any leaked test nodes
    const ctx = await createRealContext();
    await cleanupTestData(ctx.memgraph);
    await ctx.shutdown();
  });

  // -------------------------------------------------------------------------
  // Fast custom DAG (no LLM)
  // -------------------------------------------------------------------------

  test(
    "custom ingest → search → rank pipeline executes without errors",
    async () => {
      await withFreshCtx(async (ctx) => {
        const workflow = {
          name: "fast-pipeline",
          version: "1.0",
          entry: "ingest",
          stages: [
            {
              id: "ingest",
              module: "ChunkIngestor",
              config: { vectorDim: 768 },
              next: "search",
            },
            {
              id: "search",
              module: "VectorSearch",
              config: { topK: 5, minScore: 0.3, weight: 1.0 },
              next: "rank",
            },
            {
              id: "rank",
              module: "ResultRanker",
              config: { topK: 3, tokenBudget: 1000, usePyramid: false },
            },
          ],
        };

        const engine = new WorkflowEngine(workflow);
        await engine.initializeWithContext(ctx);

        try {
          const chunks = [
            { pageContent: "MemFlow is a workflow engine.", metadata: { id: "__test__pl-1", source: "__test__" } },
            { pageContent: "LightRAG combines vectors and graphs.", metadata: { id: "__test__pl-2", source: "__test__" } },
            { pageContent: "S2 chunking uses spectral clustering.", metadata: { id: "__test__pl-3", source: "__test__" } },
          ];
          const embeddings = await ctx.getEmbeddings().embedDocuments(chunks.map((c) => c.pageContent));

          const state = await engine.run({
            chunks,
            embeddings,
            query: "How does MemFlow work?",
          });

          expect(state.errors.length).toBe(0);
          expect(state.data.retrievalResult).toBeDefined();
          const result = state.data.retrievalResult as any;
          expect(Array.isArray(result.chunks)).toBe(true);
          expect(state.history.length).toBe(3);
          expect(state.history.map((h) => h.stage)).toEqual(["ingest", "search", "rank"]);
        } finally {
          await engine.shutdown();
        }
      });
    },
    { timeout: LLM_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Parallel branches
  // -------------------------------------------------------------------------

  test(
    "parallel vector + graph + keyword branches merge correctly",
    async () => {
      await withFreshCtx(async (ctx) => {
        // Seed chunks
        const chunks = [
          { pageContent: "MemFlow uses Memgraph for graph storage.", metadata: { id: "__test__par-1", source: "__test__" } },
          { pageContent: "LightRAG combines vectors and graphs for retrieval.", metadata: { id: "__test__par-2", source: "__test__" } },
        ];
        const embeddings = await ctx.getEmbeddings().embedDocuments(chunks.map((c) => c.pageContent));
        await ctx.memgraph.batchQuery(
          `UNWIND $items AS item MERGE (c:Chunk {id: item.id}) SET c.text = item.text, c.embedding = item.emb, c.source = item.source`,
          chunks.map((c, i) => ({
            id: c.metadata.id,
            text: c.pageContent,
            emb: embeddings[i],
            source: c.metadata.source,
          })),
        );

        const workflow = {
          name: "parallel-test",
          version: "1.0",
          entry: "start",
          stages: [
            {
              id: "start",
              module: "ChunkIngestor",
              config: { vectorDim: 768 },
              next: ["vector", "graph", "keyword"],
            },
            {
              id: "vector",
              module: "VectorSearch",
              config: { topK: 3, minScore: 0.3, weight: 1.0 },
              dependsOn: ["start"],
              next: "rank",
            },
            {
              id: "graph",
              module: "GraphSearch",
              config: { topK: 3, weight: 1.0, maxHops: 2 },
              dependsOn: ["start"],
              next: "rank",
            },
            {
              id: "keyword",
              module: "KeywordSearch",
              config: { topK: 3, weight: 1.0, searchMode: "text_search" },
              dependsOn: ["start"],
              next: "rank",
            },
            {
              id: "rank",
              module: "ResultRanker",
              config: { topK: 5, tokenBudget: 1000, usePyramid: false },
              dependsOn: ["vector", "graph", "keyword"],
            },
          ],
        };

        const engine = new WorkflowEngine(workflow);
        await engine.initializeWithContext(ctx);

        try {
          const state = await engine.run({ query: "MemFlow graph storage" });
          expect(state.errors.length).toBe(0);
          expect(state.data.retrievalResult).toBeDefined();
          // Ranker should have received candidates from all branches
          expect(state.history.length).toBe(5);
        } finally {
          await engine.shutdown();
        }
      });
    },
    { timeout: LLM_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Sub-workflow nesting
  // -------------------------------------------------------------------------

  test(
    "SubWorkflow nests a child engine with shared context",
    async () => {
      await withFreshCtx(async (ctx) => {
        const childWorkflow = {
          name: "child",
          version: "1.0",
          entry: "s1",
          stages: [
            {
              id: "s1",
              module: "ChunkIngestor",
              config: { vectorDim: 768 },
            },
          ],
        };

        const parentWorkflow = {
          name: "parent",
          version: "1.0",
          entry: "child",
          stages: [
            {
              id: "child",
              module: "SubWorkflow",
              config: {
                workflow: childWorkflow,
                inputMap: { chunks: "chunks", embeddings: "embeddings" },
                outputMap: { ingested: "ingested" },
              },
            },
          ],
        };

        const engine = new WorkflowEngine(parentWorkflow);
        await engine.initializeWithContext(ctx);

        try {
          const chunks = [
            { pageContent: "Nested workflow test.", metadata: { id: "__test__sub-1", source: "__test__" } },
          ];
          const embeddings = await ctx.getEmbeddings().embedDocuments(chunks.map((c) => c.pageContent));
          const state = await engine.run({ chunks, embeddings });

          expect(state.errors.length).toBe(0);
          // ChunkIngestor outputs data.chunks and metrics.ingested
          expect(state.data.chunks).toBeDefined();
        } finally {
          await engine.shutdown();
        }
      });
    },
    { timeout: LLM_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // LLM-heavy reference pipelines — todo on CPU
  // -------------------------------------------------------------------------

  test.todo("simplemem-pipeline.json produces memoryUnits (slow on CPU — 10–15 min)", () => {});
  test.todo("hybrid-retrieval.json returns ranked candidates (slow on CPU — 5–10 min)", () => {});
  test.todo("graph-indexing.json extracts entities and detects communities (slow on CPU — 10–20 min)", () => {});
  test.todo("priha-fusion.json generates an answer with citations (slow on CPU — 10–15 min)", () => {});
  test.todo("lightmem-pipeline.json processes through sensory → STM → consolidation (slow on CPU — 15–20 min)", () => {});
});
