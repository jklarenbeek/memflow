/**
 * Graph & Ingestion E2E Integration Tests — Phase 2
 *
 * Tests Phase 2 REST endpoints against live Memgraph + MemFlow server:
 * - POST /api/v1/ingest — File ingestion with markdown file
 * - GET /api/v1/graph/stats — Detailed per-solution statistics
 * - GET /api/v1/graph/communities — Community listing
 * - GET /api/v1/graph/neighbors/:id — Neighbor traversal
 * - POST → GET /api/v1/solutions — Round-trip with domain field
 * - GET /api/v1/gmpl/patterns — GMPL pattern listing
 *
 * Prerequisites:
 *   - Memgraph running: docker compose -f docker/docker-compose.yml --profile cpu up
 *   - MemFlow server: bun run dev
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServiceHealth, MEMGRAPH_TIMEOUT, LLM_TIMEOUT } from "./_setup.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";

const BASE_URL = process.env.MEMFLOW_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/v1`;

// State shared across tests
let testSolutionId: string;
let mgClient: MemgraphClient;

async function api(path: string, options?: RequestInit) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup & teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await checkServiceHealth();
  if (!health.memgraph) {
    throw new Error("Memgraph is not available — start it before running tests");
  }

  mgClient = new MemgraphClient(
    {
      uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
      user: process.env.MEMGRAPH_USER ?? "memgraph",
      password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  );

  // Clean up any leftover test data
  await cleanupGraphTestData(mgClient);
});

afterAll(async () => {
  await cleanupGraphTestData(mgClient);
  await mgClient.close();
});

async function cleanupGraphTestData(client: MemgraphClient) {
  try {
    await client.query(`
      MATCH (n)
      WHERE n.name STARTS WITH '__graph_e2e__'
        OR n.id STARTS WITH '__graph_e2e__'
      DETACH DELETE n
    `);
  } catch {
    // Best-effort cleanup
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /ingest — File ingestion with a markdown file
// ─────────────────────────────────────────────────────────────────────────────

describe("File Ingestion API", () => {
  test("POST /ingest — Upload markdown file via multipart/form-data", async () => {
    // First create a solution for ingestion
    const solRes = await api("/solutions", {
      method: "POST",
      body: JSON.stringify({
        name: "__graph_e2e__Ingestion Solution",
        description: "E2E test for file ingestion",
        domain: "research",
      }),
    });
    expect(solRes.status).toBe(201);
    testSolutionId = (solRes.data.solution as Record<string, unknown>).id as string;

    // Create a test markdown file as Blob
    const mdContent = [
      "# MemFlow Test Document",
      "",
      "## Overview",
      "MemFlow is a self-improving RAG and lifelong memory workflow engine.",
      "",
      "## Architecture",
      "The system uses Memgraph for knowledge graph storage.",
      "S2 chunking provides spatial-semantic document parsing.",
      "",
      "## Features",
      "- Multi-agent orchestration via GMPL patterns",
      "- Progressive graph expansion",
      "- Real-time SSE streaming for workflow execution",
    ].join("\n");

    const formData = new FormData();
    formData.append("file", new Blob([mdContent], { type: "text/markdown" }), "test-document.md");
    formData.append("solutionId", testSolutionId);

    const res = await fetch(`${API}/ingest`, {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = await res.json() as Record<string, unknown>;
    expect(data.success).toBe(true);
    // Ingestion returns a workflow identifier or acknowledgment
    expect(data.workflow ?? data.message ?? data.status).toBeDefined();
  }, LLM_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /graph/stats — Detailed per-solution statistics
// ─────────────────────────────────────────────────────────────────────────────

describe("Graph Stats API", () => {
  test("GET /graph/stats — Returns node and relation counts", async () => {
    const { status, data } = await api("/graph/stats");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.nodeCounts)).toBe(true);
    expect(Array.isArray(data.relationCounts)).toBe(true);

    // Each entry should have label/type and count
    const nodeCounts = data.nodeCounts as Array<Record<string, unknown>>;
    for (const entry of nodeCounts) {
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.count).toBe("number");
      expect(entry.count).toBeGreaterThanOrEqual(0);
    }
  }, MEMGRAPH_TIMEOUT);

  test("GET /graph/stats?solutionId — Filters by solution", async () => {
    if (!testSolutionId) return; // Skip if ingestion test didn't run

    const { status, data } = await api(`/graph/stats?solutionId=${testSolutionId}`);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.nodeCounts)).toBe(true);
    expect(Array.isArray(data.relationCounts)).toBe(true);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /graph/communities — Community listing
// ─────────────────────────────────────────────────────────────────────────────

describe("Graph Communities API", () => {
  test("GET /graph/communities — Returns community objects", async () => {
    const { status, data } = await api("/graph/communities");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.communities)).toBe(true);
    expect(typeof data.count).toBe("number");

    // If communities exist, verify structure
    const communities = data.communities as Array<Record<string, unknown>>;
    for (const community of communities) {
      expect(typeof community.memberCount).toBe("number");
      expect(community.memberCount).toBeGreaterThanOrEqual(0);
    }
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /graph/neighbors/:id — Neighbor traversal
// ─────────────────────────────────────────────────────────────────────────────

describe("Graph Neighbors API", () => {
  test("GET /graph/neighbors/:id — Returns neighbors for an existing node", async () => {
    // Find any node with an id to test against
    const nodeResult = await mgClient.query<{ id: string }>(
      `MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id LIMIT 1`,
    );

    if (nodeResult.length === 0) {
      // No nodes in graph — skip gracefully
      console.warn("  ⚠ No nodes in graph — skipping neighbors test");
      return;
    }

    const nodeId = nodeResult[0].id;
    const { status, data } = await api(`/graph/neighbors/${encodeURIComponent(nodeId)}`);

    expect(status).toBe(200);
    expect(data.success).toBe(true);

    // node field should be present
    const node = data.node as Record<string, unknown>;
    expect(node).toBeDefined();
    expect(Array.isArray(node.labels)).toBe(true);

    // neighbors should be an array
    const neighbors = data.neighbors as Array<Record<string, unknown>>;
    expect(Array.isArray(neighbors)).toBe(true);

    // Each neighbor should have node, edge, and direction
    for (const neighbor of neighbors) {
      const neighborNode = neighbor.node as Record<string, unknown>;
      expect(neighborNode).toBeDefined();
      expect(Array.isArray(neighborNode.labels)).toBe(true);
      expect(typeof neighbor.edge).toBe("string");
      expect(["incoming", "outgoing"]).toContain(neighbor.direction as string);
    }
  }, MEMGRAPH_TIMEOUT);

  test("GET /graph/neighbors/:id — Returns 404 for non-existent node", async () => {
    const { status, data } = await api("/graph/neighbors/nonexistent-node-id-12345");

    expect(status).toBe(404);
    expect(data.success).toBe(false);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST → GET /solutions — Round-trip with domain field
// ─────────────────────────────────────────────────────────────────────────────

describe("Solution Domain Round-Trip", () => {
  let roundTripSolutionId: string;

  test("POST /solutions — Create with explicit domain", async () => {
    const { status, data } = await api("/solutions", {
      method: "POST",
      body: JSON.stringify({
        name: "__graph_e2e__Domain Test",
        description: "Domain round-trip test",
        domain: "healthcare",
        llmProvider: "ollama",
        llmModel: "qwen3.5:4b",
      }),
    });

    expect(status).toBe(201);
    expect(data.success).toBe(true);
    const sol = data.solution as Record<string, unknown>;
    roundTripSolutionId = sol.id as string;
    expect(sol.domain).toBe("healthcare");
    expect(sol.llmProvider).toBe("ollama");
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions — Domain preserved in listing", async () => {
    const { status, data } = await api("/solutions");

    expect(status).toBe(200);
    const solutions = data.solutions as Array<Record<string, unknown>>;
    const found = solutions.find(s => s.id === roundTripSolutionId);
    expect(found).toBeDefined();
    expect(found!.domain).toBe("healthcare");
  }, MEMGRAPH_TIMEOUT);

  test("POST /solutions — Default domain is 'custom'", async () => {
    const { status, data } = await api("/solutions", {
      method: "POST",
      body: JSON.stringify({
        name: "__graph_e2e__Default Domain",
        description: "No explicit domain",
      }),
    });

    expect(status).toBe(201);
    const sol = data.solution as Record<string, unknown>;
    expect(sol.domain).toBe("custom");

    // Cleanup: soft-delete this solution
    await api(`/solutions/${sol.id}`, { method: "DELETE" });
  }, MEMGRAPH_TIMEOUT);

  // Cleanup after domain tests
  afterAll(async () => {
    if (roundTripSolutionId) {
      await api(`/solutions/${roundTripSolutionId}`, { method: "DELETE" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GET /gmpl/patterns — GMPL pattern listing
// ─────────────────────────────────────────────────────────────────────────────

describe("GMPL Patterns API", () => {
  test("GET /gmpl/patterns — Returns pattern objects", async () => {
    const { status, data } = await api("/gmpl/patterns");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.patterns)).toBe(true);

    const patterns = data.patterns as Array<Record<string, unknown>>;
    // GMPL should have at least some registered patterns
    expect(patterns.length).toBeGreaterThan(0);

    // Each pattern should have required fields
    for (const pattern of patterns) {
      expect(typeof pattern.id).toBe("string");
      expect(typeof pattern.description).toBe("string");
      expect(Array.isArray(pattern.requiredRoles)).toBe(true);
    }
  }, MEMGRAPH_TIMEOUT);

  test("GET /gmpl/roles — Returns role listing", async () => {
    const { status, data } = await api("/gmpl/roles");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.roles)).toBe(true);
  }, MEMGRAPH_TIMEOUT);
});
