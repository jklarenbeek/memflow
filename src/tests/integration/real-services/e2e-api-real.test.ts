/**
 * Layer 6 — End-to-End API Tests
 *
 * Validates the HTTP server and full workflows through the REST/MCP
 * surface using real Memgraph + Ollama backends.
 *
 * NOTE: Endpoints that trigger LLM-heavy workflows (/workflow/run with
 * complex pipelines, /api/v1/memories, /api/v1/recall, MCP memflow_write,
 * MCP memflow_recall) are marked as todo on CPU because qwen3.5:4b takes
 * 2–5 min per LLM call and the service workflows involve multiple stages.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../../../server/index.js";
import { Hono } from "hono";
import {
  checkServiceHealth,
  cleanupTestData,
  createRealContext,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import { WorkflowContext } from "../../../core/WorkflowContext.js";

const servicesHealthy = await checkServiceHealth();
let app: Hono;
let ctx: WorkflowContext;

describe.skipIf(!servicesHealthy.memgraph)("E2E API (real services)", () => {
  beforeAll(async () => {
    ctx = await createRealContext();
    app = createServer({
      memgraphUri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
      memgraphUser: process.env.MEMGRAPH_USER ?? "memgraph",
      memgraphPassword: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
      llmProvider: "ollama",
      llmModel: process.env.LLM_MODEL ?? "qwen3.5:4b",
      embeddingProvider: "ollama",
      embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
      logLevel: "warn",
    });
  });

  afterAll(async () => {
    if (ctx) {
      await cleanupTestData(ctx.memgraph);
      await ctx.shutdown();
    }
  });

  // -------------------------------------------------------------------------
  // Health & Discovery (fast)
  // -------------------------------------------------------------------------

  test(
    "GET /health returns ok with connected services",
    async () => {
      const res = await app.fetch(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("ok");
      expect(body.checks.memgraph).toBe("connected");
      expect(body.checks.ollama).toBe("reachable");
      expect(Array.isArray(body.modules)).toBe(true);
      expect(body.modules.length).toBeGreaterThan(0);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "GET /modules lists all registered modules",
    async () => {
      const res = await app.fetch(new Request("http://localhost/modules"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Array.isArray(body.modules)).toBe(true);
      expect(body.modules.length).toBeGreaterThanOrEqual(60);
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "GET /metrics returns Prometheus exposition format",
    async () => {
      const res = await app.fetch(new Request("http://localhost/metrics"));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("# HELP");
      expect(text).toContain("stage_duration_seconds");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  // -------------------------------------------------------------------------
  // Workflow Execution
  // -------------------------------------------------------------------------

  test.todo("POST /workflow/run executes quick-qa workflow (slow on CPU — 5–10 min)");

  // -------------------------------------------------------------------------
  // REST API
  // -------------------------------------------------------------------------

  test.todo("POST /api/v1/memories creates a memory (slow on CPU — 5–10 min via SimpleMem pipeline)");
  test.todo("GET /api/v1/memories/:id retrieves memory with relations (depends on memory creation)");
  test.todo("POST /api/v1/recall returns search + LLM answer (slow on CPU — 5–10 min)");

  // -------------------------------------------------------------------------
  // MCP (fast JSON-RPC)
  // -------------------------------------------------------------------------

  test(
    "POST /mcp initialize returns server info",
    async () => {
      const res = await app.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.result.serverInfo.name).toBe("memflow-mcp");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test(
    "POST /mcp tools/list returns all tools",
    async () => {
      const res = await app.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const tools = body.result.tools as Array<{ name: string }>;
      expect(tools.length).toBeGreaterThanOrEqual(7);
      const names = tools.map((t) => t.name);
      expect(names).toContain("memflow_write");
      expect(names).toContain("memflow_recall");
      expect(names).toContain("gmpl_run_pattern");
    },
    { timeout: MEMGRAPH_TIMEOUT },
  );

  test.todo("POST /mcp memflow_write ingests content (slow on CPU — 5–10 min via SimpleMem pipeline)");
  test.todo("POST /mcp memflow_recall returns an answer (slow on CPU — 5–10 min)");
});
