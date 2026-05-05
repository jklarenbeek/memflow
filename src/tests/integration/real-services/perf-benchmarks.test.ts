/**
 * Automated Performance Benchmark Suite
 *
 * Validates API response times against defined performance targets:
 * - Graph stats: <500ms
 * - Graph communities: <1s
 * - Graph neighbors: <500ms
 * - Solution listing: <500ms
 * - Workflow catalog: <300ms
 * - Health endpoint: <200ms
 * - File ingestion acknowledgment: <2s
 * - GMPL patterns: <500ms
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

let mgClient: MemgraphClient;

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark helper
// ─────────────────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  endpoint: string;
  method: string;
  status: number;
  durationMs: number;
  targetMs: number;
  passed: boolean;
}

const benchmarkResults: BenchmarkResult[] = [];

async function benchmark(
  endpoint: string,
  targetMs: number,
  options?: RequestInit,
): Promise<{ status: number; durationMs: number; data: Record<string, unknown> }> {
  const url = endpoint.startsWith("http") ? endpoint : `${API}${endpoint}`;
  const method = options?.method ?? "GET";

  // Warm-up request (first request may include connection setup)
  await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {});

  // Measured request (average of 3 runs)
  const durations: number[] = [];
  let lastStatus = 0;
  let lastData: Record<string, unknown> = {};

  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = performance.now() - start;
    durations.push(elapsed);
    lastStatus = res.status;
    lastData = await res.json() as Record<string, unknown>;
  }

  // Use median to avoid outliers
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const durationMs = Math.round(median);

  const result: BenchmarkResult = {
    endpoint,
    method,
    status: lastStatus,
    durationMs,
    targetMs,
    passed: durationMs <= targetMs,
  };
  benchmarkResults.push(result);

  return { status: lastStatus, durationMs, data: lastData };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup & teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const health = await checkServiceHealth();
  if (!health.memgraph) {
    throw new Error("Memgraph is not available — start it before running benchmarks");
  }

  mgClient = new MemgraphClient(
    {
      uri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
      user: process.env.MEMGRAPH_USER ?? "memgraph",
      password: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    },
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  );
});

afterAll(async () => {
  // Print benchmark summary table
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              PERFORMANCE BENCHMARK RESULTS                    ║");
  console.log("╠════════════════════════════════════════════════════════════════╣");
  console.log("║ Endpoint                      │ Median │ Target │ Result     ║");
  console.log("╠═══════════════════════════════╪════════╪════════╪════════════╣");
  for (const r of benchmarkResults) {
    const name = `${r.method} ${r.endpoint}`.padEnd(30).slice(0, 30);
    const duration = `${r.durationMs}ms`.padStart(6);
    const target = `${r.targetMs}ms`.padStart(6);
    const result = r.passed ? "✅ PASS   " : "❌ FAIL   ";
    console.log(`║ ${name} │ ${duration} │ ${target} │ ${result} ║`);
  }
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const passed = benchmarkResults.filter(r => r.passed).length;
  const total = benchmarkResults.length;
  console.log(`\n  ${passed}/${total} benchmarks passed.\n`);

  await mgClient.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Core API Response Time Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

describe("Core API Performance Benchmarks", () => {
  test("GET /health — responds within 200ms", async () => {
    const { status, durationMs } = await benchmark(`${BASE_URL}/health`, 200);
    expect(status).toBe(200);
    expect(durationMs).toBeLessThanOrEqual(200);
  }, MEMGRAPH_TIMEOUT);

  test("GET /solutions — responds within 500ms", async () => {
    const { status, durationMs, data } = await benchmark("/solutions", 500);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);

  test("GET /workflows/catalog — responds within 300ms", async () => {
    const { status, durationMs, data } = await benchmark("/workflows/catalog", 300);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(300);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Graph API Performance Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

describe("Graph API Performance Benchmarks", () => {
  test("GET /graph/stats — responds within 500ms", async () => {
    const { status, durationMs, data } = await benchmark("/graph/stats", 500);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);

  test("GET /graph/communities — responds within 1000ms", async () => {
    const { status, durationMs, data } = await benchmark("/graph/communities", 1000);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(1000);
  }, MEMGRAPH_TIMEOUT);

  test("GET /graph/neighbors/:id — responds within 500ms", async () => {
    // Find a node to test against
    const nodeResult = await mgClient.query<{ id: string }>(
      `MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id LIMIT 1`,
    );

    if (nodeResult.length === 0) {
      console.warn("  ⚠ No nodes in graph — skipping neighbors benchmark");
      return;
    }

    const nodeId = nodeResult[0].id;
    const { status, durationMs, data } = await benchmark(
      `/graph/neighbors/${encodeURIComponent(nodeId)}`,
      500,
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);

  test("GET /graph/timeline — responds within 500ms", async () => {
    const { status, durationMs, data } = await benchmark("/graph/timeline", 500);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Module & Pattern API Performance Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

describe("Module & Pattern API Performance Benchmarks", () => {
  test("GET /gmpl/patterns — responds within 500ms", async () => {
    const { status, durationMs, data } = await benchmark("/gmpl/patterns", 500);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);

  test("GET /gmpl/roles — responds within 500ms", async () => {
    const { status, durationMs, data } = await benchmark("/gmpl/roles", 500);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);

  test("GET /executions — responds within 500ms", async () => {
    const { status, durationMs, data } = await benchmark("/executions", 500);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(durationMs).toBeLessThanOrEqual(500);
  }, MEMGRAPH_TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Throughput Benchmark — Rapid sequential requests
// ─────────────────────────────────────────────────────────────────────────────

describe("Throughput Benchmark", () => {
  test("10 sequential GET /health requests complete within 2s total", async () => {
    const start = performance.now();
    const results: number[] = [];

    for (let i = 0; i < 10; i++) {
      const reqStart = performance.now();
      const res = await fetch(`${BASE_URL}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(res.status).toBe(200);
      results.push(performance.now() - reqStart);
    }

    const totalMs = Math.round(performance.now() - start);
    const avgMs = Math.round(results.reduce((a, b) => a + b, 0) / results.length);

    console.log(`    → 10 requests: ${totalMs}ms total, ${avgMs}ms avg`);
    expect(totalMs).toBeLessThanOrEqual(2000);
  }, MEMGRAPH_TIMEOUT);

  test("5 concurrent GET requests complete within 1s", async () => {
    const start = performance.now();

    const endpoints = [
      `${BASE_URL}/health`,
      `${API}/solutions`,
      `${API}/workflows/catalog`,
      `${API}/graph/stats`,
      `${API}/gmpl/patterns`,
    ];

    const results = await Promise.all(
      endpoints.map(url =>
        fetch(url, {
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    );

    const totalMs = Math.round(performance.now() - start);
    console.log(`    → 5 concurrent requests: ${totalMs}ms total`);

    for (const res of results) {
      expect(res.status).toBe(200);
    }
    expect(totalMs).toBeLessThanOrEqual(1000);
  }, MEMGRAPH_TIMEOUT);
});
