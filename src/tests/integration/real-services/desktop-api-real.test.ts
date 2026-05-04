/**
 * Desktop API Integration Tests
 *
 * Tests all Phase 1 REST endpoints against a live Memgraph instance:
 * - Solution CRUD (POST/GET/PATCH/DELETE)
 * - Conversation + Message persistence
 * - Workflow Catalog scanning
 * - Migration (solutionId backfill)
 * - Graph traversal verification (:Solution → :Conversation → :Message)
 *
 * Prerequisites:
 *   - Memgraph running: docker compose -f docker/docker-compose.yml --profile cpu up
 *   - MemFlow server: bun run dev
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkServiceHealth, MEMGRAPH_TIMEOUT } from "./_setup.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";

const BASE_URL = process.env.MEMFLOW_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/v1`;

// State shared across tests
let solutionId: string;
let conversationId: string;
let userMessageId: string;
let assistantMessageId: string;
let mgClient: MemgraphClient;

/**
 * NOTE: The `props()` and `num()` helpers that were here have been removed.
 * Routes now normalize all Memgraph Node/Integer objects via `normalizeNode()`
 * in `src/server/routes/_helpers.ts`, so responses are flat JSON.
 */

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
  await cleanupDesktopTestData(mgClient);
});

afterAll(async () => {
  await cleanupDesktopTestData(mgClient);
  await mgClient.close();
});

async function cleanupDesktopTestData(client: MemgraphClient) {
  try {
    // Remove test solutions and cascading data
    await client.query(`
      MATCH (n)
      WHERE n.name STARTS WITH '__desktop_test__'
        OR n.id STARTS WITH '__desktop_test__'
        OR (n:MigrationLog AND n.migrationId = 'v1_backfill_solutionId')
      DETACH DELETE n
    `);
  } catch {
    // Best-effort cleanup
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Solution CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe("Solution CRUD API", () => {
  test("POST /solutions — Create a solution", async () => {
    const { status, data } = await api("/solutions", {
      method: "POST",
      body: JSON.stringify({
        name: "__desktop_test__My Research",
        description: "Integration test solution",
        domain: "research",
      }),
    });

    expect(status).toBe(201);
    expect(data.success).toBe(true);
    expect((data.solution as Record<string, unknown>).name).toBe("__desktop_test__My Research");
    expect((data.solution as Record<string, unknown>).domain).toBe("research");
    solutionId = (data.solution as Record<string, unknown>).id as string;
    expect(solutionId).toBeDefined();
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions — List solutions (includes new one)", async () => {
    const { status, data } = await api("/solutions");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const solutions = data.solutions as Array<Record<string, unknown>>;
    const found = solutions.find(s => s.id === solutionId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("__desktop_test__My Research");
    expect(found!.stats).toBeDefined();
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions/:id — Get specific solution", async () => {
    const { status, data } = await api(`/solutions/${solutionId}`);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const sol = data.solution as Record<string, unknown>;
    expect(sol.id).toBe(solutionId);
    expect(sol.description).toBe("Integration test solution");
  }, MEMGRAPH_TIMEOUT);

  test("PATCH /solutions/:id — Update solution", async () => {
    const { status, data } = await api(`/solutions/${solutionId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "__desktop_test__Renamed Solution", domain: "trading" }),
    });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const sol = data.solution as Record<string, unknown>;
    expect(sol.name).toBe("__desktop_test__Renamed Solution");
    expect(sol.domain).toBe("trading");
  }, MEMGRAPH_TIMEOUT);

  test("POST /solutions — Validation error on empty name", async () => {
    const { status, data } = await api("/solutions", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });

    expect(status).toBe(400);
    expect(data.success).toBe(false);
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions/:id — 404 for non-existent solution", async () => {
    const { status, data } = await api("/solutions/00000000-0000-0000-0000-000000000000");

    expect(status).toBe(404);
    expect(data.success).toBe(false);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Conversation + Message Persistence
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation + Message API", () => {
  test("POST /conversations — Create conversation linked to solution", async () => {
    const { status, data } = await api("/conversations", {
      method: "POST",
      body: JSON.stringify({
        solutionId,
        title: "__desktop_test__First Chat",
        workflowName: "chat",
      }),
    });

    expect(status).toBe(201);
    expect(data.success).toBe(true);
    const conv = data.conversation as Record<string, unknown>;
    conversationId = conv.id as string;
    expect(conversationId).toBeDefined();
    expect(conv.title).toBe("__desktop_test__First Chat");
  }, MEMGRAPH_TIMEOUT);

  test("POST /conversations/:id/messages — Add user message", async () => {
    const { status, data } = await api(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        role: "user",
        content: "What is MemFlow?",
      }),
    });

    expect(status).toBe(201);
    expect(data.success).toBe(true);
    const msg = data.message as Record<string, unknown>;
    userMessageId = msg.id as string;
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("What is MemFlow?");
  }, MEMGRAPH_TIMEOUT);

  test("POST /conversations/:id/messages — Add assistant placeholder", async () => {
    const { status, data } = await api(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        role: "assistant",
        content: "",
        workflowId: "wf-123",
        workflowName: "chat",
      }),
    });

    expect(status).toBe(201);
    const msg = data.message as Record<string, unknown>;
    assistantMessageId = msg.id as string;
    expect(msg.role).toBe("assistant");
    expect(msg.workflowName).toBe("chat");
  }, MEMGRAPH_TIMEOUT);

  test("PATCH /conversations/:id/messages/:mid — Update with audit trail", async () => {
    const stageTrace = [
      { stageId: "classify", module: "IntentClassifier", durationMs: 120, status: "complete" },
      { stageId: "retrieve", module: "LightRAGRetriever", durationMs: 850, status: "complete" },
      { stageId: "generate", module: "AnswerGenerator", durationMs: 2100, status: "complete" },
    ];

    const { status, data } = await api(`/conversations/${conversationId}/messages/${assistantMessageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: "MemFlow is a self-improving RAG and lifelong memory workflow engine.",
        stageTrace,
        stageCount: 3,
        durationMs: 3070,
        sources: ["doc:memflow-readme", "graph:entity-memflow"],
        tokenUsage: 450,
      }),
    });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const msg = data.message as Record<string, unknown>;
    expect(msg.content).toBe("MemFlow is a self-improving RAG and lifelong memory workflow engine.");
    expect(Number(msg.stageCount)).toBe(3);
    expect(Number(msg.durationMs)).toBe(3070);
    expect(Number(msg.tokenUsage)).toBe(450);
  }, MEMGRAPH_TIMEOUT);

  test("GET /conversations?solutionId — List conversations for solution", async () => {
    const { status, data } = await api(`/conversations?solutionId=${solutionId}`);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const rawConvos = data.conversations as Array<Record<string, unknown>>;
    expect(rawConvos.length).toBeGreaterThanOrEqual(1);
    const found = rawConvos.find(c => c.id === conversationId);
    expect(found).toBeDefined();
  }, MEMGRAPH_TIMEOUT);

  test("GET /conversations/:id — Get conversation with messages", async () => {
    const { status, data } = await api(`/conversations/${conversationId}`);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const messages = data.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2); // user + assistant
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("MemFlow is a self-improving RAG and lifelong memory workflow engine.");
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graph Traversal Verification
// ─────────────────────────────────────────────────────────────────────────────

describe("Graph Traversal (:Solution → :Conversation → :Message)", () => {
  test("BELONGS_TO edge exists from Conversation to Solution", async () => {
    const result = await mgClient.query<{ sid: string }>(
      `MATCH (c:Conversation {id: $cid})-[:BELONGS_TO]->(s:Solution {id: $sid})
       RETURN s.id AS sid`,
      { cid: conversationId, sid: solutionId },
    );
    expect(result.length).toBe(1);
    expect(result[0].sid).toBe(solutionId);
  }, MEMGRAPH_TIMEOUT);

  test("IN_CONVERSATION edges exist from Messages to Conversation", async () => {
    const result = await mgClient.query<{ mid: string; role: string }>(
      `MATCH (m:Message)-[:IN_CONVERSATION]->(c:Conversation {id: $cid})
       RETURN m.id AS mid, m.role AS role
       ORDER BY m.createdAt ASC`,
      { cid: conversationId },
    );
    expect(result.length).toBe(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  }, MEMGRAPH_TIMEOUT);

  test("Full path traversal: Solution → Conversation → Message", async () => {
    const result = await mgClient.query<{ sName: string; cTitle: string; msgCount: number }>(
      `MATCH (s:Solution {id: $sid})<-[:BELONGS_TO]-(c:Conversation)
       MATCH (m:Message)-[:IN_CONVERSATION]->(c)
       RETURN s.name AS sName, c.title AS cTitle, count(m) AS msgCount`,
      { sid: solutionId },
    );
    expect(result.length).toBe(1);
    expect(result[0].sName).toBe("__desktop_test__Renamed Solution");
    expect(result[0].cTitle).toBe("__desktop_test__First Chat");
    expect(Number(result[0].msgCount)).toBe(2);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Workflow Catalog
// ─────────────────────────────────────────────────────────────────────────────

describe("Workflow Catalog API", () => {
  test("GET /workflows/catalog — Enumerate available workflows", async () => {
    const { status, data } = await api("/workflows/catalog");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const workflows = data.workflows as Array<Record<string, unknown>>;
    expect(Array.isArray(workflows)).toBe(true);
    expect(workflows.length).toBeGreaterThan(0);

    // Verify expected categories exist
    const categories = new Set(workflows.map(w => w.category));
    expect(categories.has("example")).toBe(true);
    expect(categories.has("sub")).toBe(true);

    // Verify chat.json service workflow exists
    const chatWorkflow = workflows.find(w => w.name === "chat");
    expect(chatWorkflow).toBeDefined();
    expect(chatWorkflow!.category).toBe("service");
  }, MEMGRAPH_TIMEOUT);

  test("GET /workflows/catalog/:name — Get specific workflow", async () => {
    const { status, data } = await api("/workflows/catalog/chat");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const wf = data.workflow as Record<string, unknown>;
    expect(wf.name).toBe("chat");
    expect(wf.entry).toBeDefined();
    expect(Array.isArray(wf.stages)).toBe(true);
  }, MEMGRAPH_TIMEOUT);

  test("GET /workflows/catalog/:name — 404 for non-existent workflow", async () => {
    const { status, data } = await api("/workflows/catalog/nonexistent-workflow-xyz");

    expect(status).toBe(404);
    expect(data.success).toBe(false);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Migration
// ─────────────────────────────────────────────────────────────────────────────

describe("Migration API", () => {
  test("POST /migrate — Run migration (first time)", async () => {
    const { status, data } = await api("/migrate", { method: "POST" });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    // migratedNodes may be 0 if no orphans exist
    expect(typeof data.migratedNodes).toBe("number");
  }, MEMGRAPH_TIMEOUT);

  test("POST /migrate — Idempotent (second run)", async () => {
    const { status, data } = await api("/migrate", { method: "POST" });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.alreadyRan).toBe(true);
  }, MEMGRAPH_TIMEOUT);

  test("GET /migrate/status — Check migration log", async () => {
    const { status, data } = await api("/migrate/status");

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const rawMigrations = data.migrations as Array<Record<string, unknown>>;
    expect(rawMigrations.length).toBeGreaterThanOrEqual(1);
    expect(rawMigrations[0].migrationId).toBe("v1_backfill_solutionId");
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Solution Soft-Delete (run last, after other tests used the solution)
// ─────────────────────────────────────────────────────────────────────────────

describe("Solution Soft-Delete", () => {
  test("DELETE /solutions/:id — Soft-delete solution", async () => {
    const { status, data } = await api(`/solutions/${solutionId}`, { method: "DELETE" });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.deleted).toBe(true);
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions/:id — Deleted solution returns 404", async () => {
    const { status, data } = await api(`/solutions/${solutionId}`);

    expect(status).toBe(404);
    expect(data.success).toBe(false);
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions — Deleted solution excluded from list", async () => {
    const { status, data } = await api("/solutions");

    expect(status).toBe(200);
    const solutions = data.solutions as Array<Record<string, unknown>>;
    const found = solutions.find(s => s.id === solutionId);
    expect(found).toBeUndefined();
  }, MEMGRAPH_TIMEOUT);
});
