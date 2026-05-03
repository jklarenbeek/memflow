/**
 * Shared helpers for real-service integration tests.
 *
 * Provides service health checks, test data cleanup, and real WorkflowContext
 * creation for tests that exercise Memgraph + Ollama instead of mocks.
 */

import { MemgraphClient } from "../../../providers/MemgraphClient.js";
import { WorkflowContext } from "../../../core/WorkflowContext.js";
import { Document } from "@langchain/core/documents";

// ---------------------------------------------------------------------------
// Service health checks
// ---------------------------------------------------------------------------

export interface ServiceHealth {
  memgraph: boolean;
  ollama: boolean;
  llmModel: boolean;
  embeddingModel: boolean;
}

let cachedHealth: ServiceHealth | null = null;

export async function checkServiceHealth(): Promise<ServiceHealth> {
  if (cachedHealth) return cachedHealth;

  const health: ServiceHealth = {
    memgraph: false,
    ollama: false,
    llmModel: false,
    embeddingModel: false,
  };

  // Memgraph
  try {
    const mg = new MemgraphClient(
      {
        uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
        user: process.env.MEMGRAPH_USER ?? "memgraph",
        password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
      },
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    );
    await mg.query("RETURN 1 AS n");
    await mg.close();
    health.memgraph = true;
  } catch {
    health.memgraph = false;
  }

  // Ollama
  try {
    const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      health.ollama = true;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const models = data.models?.map((m) => m.name) ?? [];
      health.llmModel = models.some((m) => m.includes(process.env.LLM_MODEL ?? "qwen3.5:4b"));
      health.embeddingModel = models.some((m) =>
        m.includes(process.env.EMBEDDING_MODEL ?? "nomic-embed-text"),
      );
    }
  } catch {
    health.ollama = false;
  }

  cachedHealth = health;
  return health;
}

export function invalidateHealthCache(): void {
  cachedHealth = null;
}

// ---------------------------------------------------------------------------
// Test data cleanup
// ---------------------------------------------------------------------------

export async function cleanupTestData(client: MemgraphClient): Promise<void> {
  try {
    // Remove all test-scoped nodes and their relationships
    await client.query(`
      MATCH (n)
      WHERE n.id STARTS WITH '__test__'
        OR n.name STARTS WITH '__test__'
        OR n.source STARTS WITH '__test__'
        OR n.communityId STARTS WITH '__test__'
      DETACH DELETE n
    `);
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Real WorkflowContext factory
// ---------------------------------------------------------------------------

export async function createRealContext(): Promise<WorkflowContext> {
  return WorkflowContext.create({
    memgraphUri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
    memgraphUser: process.env.MEMGRAPH_USER ?? "memgraph",
    memgraphPassword: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    llmProvider: "ollama",
    llmModel: process.env.LLM_MODEL ?? "qwen3.5:4b",
    embeddingProvider: "ollama",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    logLevel: "warn",
  });
}

// ---------------------------------------------------------------------------
// Test data generators
// ---------------------------------------------------------------------------

export function testChunks(): Document[] {
  return [
    new Document({
      pageContent:
        "MemFlow is a self-improving RAG and lifelong memory workflow engine built on Memgraph.",
      metadata: { id: "__test__chunk-1", source: "__test__docs" },
    }),
    new Document({
      pageContent:
        "S2 chunking uses spectral clustering on spatial and semantic affinity matrices.",
      metadata: { id: "__test__chunk-2", source: "__test__docs" },
    }),
    new Document({
      pageContent:
        "LightRAG combines vector retrieval with graph traversal for hybrid search.",
      metadata: { id: "__test__chunk-3", source: "__test__docs" },
    }),
    new Document({
      pageContent:
        "Apple Inc. is a technology company headquartered in Cupertino, California.",
      metadata: { id: "__test__chunk-4", source: "__test__docs" },
    }),
    new Document({
      pageContent:
        "The iPhone is a line of smartphones designed and marketed by Apple Inc.",
      metadata: { id: "__test__chunk-5", source: "__test__docs" },
    }),
  ];
}

export function testQuery(): string {
  return "What is MemFlow?";
}

export function testEmbedding(dim = 768): number[] {
  // Deterministic pseudo-embedding for tests
  return Array.from({ length: dim }, (_, i) => Math.sin(i * 0.1) * 0.5);
}

// ---------------------------------------------------------------------------
// Timeout helpers
// ---------------------------------------------------------------------------

/** Long timeout for tests that invoke real LLMs (ms). */
export const LLM_TIMEOUT = 120_000;

/** Medium timeout for tests that only touch Memgraph (ms). */
export const MEMGRAPH_TIMEOUT = 15_000;
