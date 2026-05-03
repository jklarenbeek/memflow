/**
 * Shared helpers for real-service integration tests.
 *
 * Provides service health checks, test data cleanup, and real WorkflowContext
 * creation for tests that exercise Memgraph + LLM providers instead of mocks.
 *
 * Provider configuration (env vars):
 *   LLM_PROVIDER       — "ollama" | "openrouter" | "openai" (default: "ollama")
 *   EMBEDDING_PROVIDER  — "ollama" | "openrouter" | "openai" (default: "ollama")
 *   LLM_MODEL           — model name (default: provider-dependent)
 *   EMBEDDING_MODEL     — model name (default: provider-dependent)
 *   OPENROUTER_API_KEY  — required when provider is "openrouter"
 *   OPENAI_API_KEY      — required when provider is "openai"
 */

import { MemgraphClient } from "../../../providers/MemgraphClient.js";
import { WorkflowContext } from "../../../core/WorkflowContext.js";
import type { GlobalConfig } from "../../../core/types.js";
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

  // LLM provider — Ollama (local) or external API (OpenRouter/OpenAI)
  const llmProvider = process.env.LLM_PROVIDER ?? "ollama";

  if (llmProvider === "ollama") {
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
  } else {
    // External API (OpenRouter, OpenAI, etc.) — check API key is present
    const apiKey =
      llmProvider === "openrouter"
        ? process.env.OPENROUTER_API_KEY
        : process.env.OPENAI_API_KEY;
    if (apiKey) {
      health.ollama = true; // re-use flag: "LLM provider is available"
      health.llmModel = true;
      health.embeddingModel = true;
    }
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
  const llmProvider = (process.env.LLM_PROVIDER ?? "ollama") as GlobalConfig["llmProvider"];
  const embeddingProvider = (process.env.EMBEDDING_PROVIDER ?? "ollama") as GlobalConfig["embeddingProvider"];

  // Default models per provider
  const defaultLlmModel =
    llmProvider === "ollama" ? "qwen3.5:4b"
    : llmProvider === "openrouter" ? "deepseek/deepseek-chat-v3-0324"
    : "gpt-4o-mini";

  const defaultEmbeddingModel =
    embeddingProvider === "ollama" ? "nomic-embed-text"
    : embeddingProvider === "openrouter" ? "openai/text-embedding-3-small"
    : "text-embedding-3-small";

  return WorkflowContext.create({
    memgraphUri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
    memgraphUser: process.env.MEMGRAPH_USER ?? "memgraph",
    memgraphPassword: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    llmProvider,
    llmModel: process.env.LLM_MODEL ?? defaultLlmModel,
    embeddingProvider,
    embeddingModel: process.env.EMBEDDING_MODEL ?? defaultEmbeddingModel,
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

/** Extended timeout for multi-stage pipelines (ms). */
export const PIPELINE_TIMEOUT = 600_000;

/** Medium timeout for tests that only touch Memgraph (ms). */
export const MEMGRAPH_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Evolution-specific helpers
// ---------------------------------------------------------------------------

/**
 * Clean up evolution test data (nodes prefixed with `__evo_test__`).
 */
export async function cleanupEvolutionTestData(client: MemgraphClient): Promise<void> {
  try {
    await client.query(`
      MATCH (n)
      WHERE n.id STARTS WITH '__evo_test__'
        OR n.name STARTS WITH '__evo_test__'
        OR n.topicId STARTS WITH '__evo_test__'
      DETACH DELETE n
    `);
  } catch {
    // Best-effort cleanup
  }

  // Also clean up any test harnesses
  try {
    await client.query(`
      MATCH (h:PredictionHarness)
      WHERE h.topicId STARTS WITH '__evo_test__'
      DETACH DELETE h
    `);
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Seed :Skill nodes with real embeddings for SkillInjector tests.
 */
export async function seedSkillNodes(
  ctx: WorkflowContext,
  skills: Array<{
    id: string;
    name: string;
    description: string;
    applicableWhen: string;
    doPatterns: string[];
    dontPatterns: string[];
  }>,
): Promise<void> {
  const embeddings = ctx.getEmbeddings();

  for (const skill of skills) {
    const embedding = await embeddings.embedQuery(
      `${skill.name} ${skill.description} ${skill.applicableWhen}`,
    );

    await ctx.memgraph.query(
      `CREATE (s:Skill {
        id: $id, name: $name, description: $description,
        applicableWhen: $applicableWhen,
        doPatterns: $doPatterns, dontPatterns: $dontPatterns,
        embedding: $embedding, version: 1,
        createdAt: $timestamp
      })`,
      {
        ...skill,
        embedding,
        timestamp: new Date().toISOString(),
      },
    );
  }
}
