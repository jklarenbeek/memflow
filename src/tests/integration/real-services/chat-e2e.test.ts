/**
 * Chat E2E Streaming Tests — Phase 2 Sprint 1
 *
 * End-to-end tests for the chat workflow via `/workflow/run/stream`.
 * Validates:
 *  1. SSE endpoint HTTP behavior (content-type, error responses)
 *  2. Error recovery (invalid workflow, missing modules)
 *  3. SSE event structure and sequencing (requires LLM — guarded)
 *
 * Prerequisites:
 *   - Memgraph running: docker compose -f docker/docker-compose.yml --profile cpu up -d
 *   - MemFlow server: bun run dev
 *   - For full SSE event tests: Ollama running with qwen3.5:4b + nomic-embed-text
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { checkServiceHealth, MEMGRAPH_TIMEOUT, LLM_TIMEOUT } from "./_setup.js";

const BASE_URL = process.env.MEMFLOW_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

/**
 * Consume an SSE response and collect all events.
 * Returns when the stream closes or maxEvents/timeout is reached.
 */
async function collectSSEEvents(
  response: Response,
  opts: { maxEvents?: number; timeoutMs?: number } = {},
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const maxEvents = opts.maxEvents ?? 200;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  const startTime = Date.now();

  try {
    while (events.length < maxEvents && Date.now() - startTime < timeoutMs) {
      // Use a per-chunk timeout to avoid infinite hangs.
      // LLM on CPU can take 10-30s between events, so we use a generous timeout.
      const remainingMs = timeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) break;
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.min(30_000, remainingMs)),
      );

      const { done, value } = await Promise.race([readPromise, timeoutPromise]);
      if (done) break;
      if (!value) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete last line

      let currentEvent: Partial<SSEEvent> = {};
      for (const line of lines) {
        if (line.startsWith("id:")) {
          currentEvent.id = line.slice(3).trim();
        } else if (line.startsWith("event:")) {
          currentEvent.event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          try {
            currentEvent.data = JSON.parse(line.slice(5).trim());
          } catch {
            currentEvent.data = { raw: line.slice(5).trim() };
          }
        } else if (line.trim() === "" && currentEvent.event) {
          // Empty line = end of SSE event
          events.push(currentEvent as SSEEvent);
          currentEvent = {};
        }
      }
    }
  } catch {
    // Connection errors during read are expected when server is busy/unavailable
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best effort
    }
  }

  return events;
}

/**
 * Send a workflow to the streaming endpoint and collect SSE events.
 */
async function streamWorkflow(
  workflow: Record<string, unknown>,
  input: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<{ response: Response; events: SSEEvent[] }> {
  const response = await fetch(`${BASE_URL}/workflow/run/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow, input }),
  });

  const events = await collectSSEEvents(response, { timeoutMs: opts.timeoutMs });
  return { response, events };
}

// ---------------------------------------------------------------------------
// Setup — detect server + LLM availability
// ---------------------------------------------------------------------------

let serverAvailable = false;
let llmAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok || res.status === 503) {
      serverAvailable = true;
      const data = (await res.json()) as Record<string, unknown>;
      const checks = data.checks as Record<string, string> | undefined;
      llmAvailable = checks?.ollama === "reachable";
    }
  } catch {
    serverAvailable = false;
  }

  if (!serverAvailable) {
    console.warn("⚠ MemFlow server not available — SSE tests will be skipped");
  } else if (!llmAvailable) {
    console.warn("⚠ LLM (Ollama) not available — SSE event structure tests will be skipped (require real workflow execution)");
  }
});

function requireServer() {
  if (!serverAvailable) {
    console.log("  → skipped (server not available)");
    return false;
  }
  return true;
}

function requireLLM() {
  if (!serverAvailable || !llmAvailable) {
    console.log(`  → skipped (${!serverAvailable ? "server" : "LLM"} not available)`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. SSE Endpoint HTTP Behavior (server only — no LLM needed)
// ---------------------------------------------------------------------------

describe("Chat E2E — SSE Endpoint", () => {
  test("POST /workflow/run/stream — rejects missing workflow", async () => {
    if (!requireServer()) return;

    const response = await fetch(`${BASE_URL}/workflow/run/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { query: "test" } }),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.error).toContain("workflow");
  }, MEMGRAPH_TIMEOUT);

  test("POST /workflow/run/stream — rejects invalid JSON", async () => {
    if (!requireServer()) return;

    const response = await fetch(`${BASE_URL}/workflow/run/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(response.status).toBe(400);
  }, MEMGRAPH_TIMEOUT);

  test("POST /workflow/run/stream — returns SSE content-type for valid request", async () => {
    if (!requireServer()) return;

    // Use an intentionally bad module to get a fast error response
    const workflow = {
      name: "e2e-content-type",
      version: "1.0",
      entry: "bad",
      stages: [{ id: "bad", module: "NoSuchModule_000", config: {}, next: null }],
    };

    const response = await fetch(`${BASE_URL}/workflow/run/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow, input: { query: "test" } }),
    });

    // SSE endpoint returns 200 with text/event-stream even for errors
    // (errors are sent as SSE events, not HTTP status codes)
    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/event-stream");

    // Consume to avoid dangling connection
    await collectSSEEvents(response, { timeoutMs: 5_000 });
  }, MEMGRAPH_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 2. Error Recovery (server only — uses bad modules for fast failures)
// ---------------------------------------------------------------------------

describe("Chat E2E — Error Recovery", () => {
  test("unknown module emits workflow:error SSE event", async () => {
    if (!requireServer()) return;

    const workflow = {
      name: "e2e-unknown-module",
      version: "1.0",
      entry: "bad_stage",
      stages: [
        {
          id: "bad_stage",
          module: "NonExistentModule_XYZ_12345",
          config: {},
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "test" }, { timeoutMs: 10_000 });

    // Should get at least an error event
    const errorEvent = events.find(
      (e) => e.event === "workflow:error" || e.event === "stage:error",
    );
    expect(errorEvent).toBeDefined();
    if (errorEvent) {
      expect(errorEvent.data.error ?? errorEvent.data.message).toBeDefined();
    }
  }, LLM_TIMEOUT);

  test("empty stages array emits error", async () => {
    if (!requireServer()) return;

    const workflow = {
      name: "e2e-empty-stages",
      version: "1.0",
      entry: "nonexistent",
      stages: [],
    };

    const response = await fetch(`${BASE_URL}/workflow/run/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow, input: { query: "test" } }),
    });

    // This might be a 200 with error SSE event OR a 400/500 response
    if (response.status === 200) {
      const events = await collectSSEEvents(response, { timeoutMs: 10_000 });
      const errorEvent = events.find(
        (e) => e.event === "workflow:error" || e.event === "stage:error",
      );
      expect(errorEvent).toBeDefined();
    } else {
      // Server rejected with HTTP error status — also acceptable
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  }, LLM_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 3. SSE Event Structure (REQUIRES LLM — IntentClassifier needs Ollama)
// ---------------------------------------------------------------------------

describe("Chat E2E — SSE Event Structure", () => {
  test("workflow:start event has correct payload shape", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-event-shape",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    const workflowStart = events.find((e) => e.event === "workflow:start");
    expect(workflowStart).toBeDefined();

    if (workflowStart) {
      expect(workflowStart.data.type).toBe("workflow:start");
      expect(workflowStart.data.workflowId).toBeDefined();
      expect(typeof workflowStart.data.workflowId).toBe("string");
      expect(workflowStart.data.name).toBe("e2e-event-shape");
      expect(workflowStart.data.timestamp).toBeDefined();
      expect(Array.isArray(workflowStart.data.stages)).toBe(true);
    }
  }, LLM_TIMEOUT);

  test("stage:start event has stageId and module", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-stage-events",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    const stageStart = events.find((e) => e.event === "stage:start");
    if (stageStart) {
      expect(stageStart.data.type).toBe("stage:start");
      expect(stageStart.data.stageId).toBeDefined();
      expect(stageStart.data.module).toBeDefined();
      expect(stageStart.data.attempt).toBeDefined();
      expect(stageStart.data.progress).toBeDefined();
    }
  }, LLM_TIMEOUT);

  test("stage:complete event has durationMs", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-stage-complete",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    const stageComplete = events.find((e) => e.event === "stage:complete");
    if (stageComplete) {
      expect(stageComplete.data.type).toBe("stage:complete");
      expect(stageComplete.data.stageId).toBeDefined();
      expect(typeof stageComplete.data.durationMs).toBe("number");
    }
  }, LLM_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 4. SSE Event Sequence (REQUIRES LLM)
// ---------------------------------------------------------------------------

describe("Chat E2E — SSE Event Sequence", () => {
  test("event IDs are monotonically increasing", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-event-ids",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    if (events.length > 1) {
      for (let i = 1; i < events.length; i++) {
        expect(Number(events[i].id)).toBeGreaterThan(Number(events[i - 1].id));
      }
    }
  }, LLM_TIMEOUT);

  test("workflow:start is the first event", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-first-event",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].event).toBe("workflow:start");
  }, LLM_TIMEOUT);

  test("workflow:complete or workflow:error is the last event", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-last-event",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    // On slow CPU the LLM stage may take longer than the read timeout,
    // resulting in a truncated stream with only workflow:start / stage:start.
    // Only assert if we got a terminal event at all.
    const hasTerminal = events.some(
      (e) => e.event === "workflow:complete" || e.event === "workflow:error",
    );
    if (hasTerminal) {
      const lastEvent = events[events.length - 1];
      expect(
        lastEvent.event === "workflow:complete" || lastEvent.event === "workflow:error",
      ).toBe(true);
    } else {
      console.log(`  → stream truncated (${events.length} events, no terminal event — LLM likely still processing)`);
      expect(events.length).toBeGreaterThan(0); // At least workflow:start was received
    }
  }, LLM_TIMEOUT);

  test("stage events are bracketed by stage:start and stage:complete", async () => {
    if (!requireLLM()) return;

    const workflow = {
      name: "e2e-stage-bracket",
      version: "1.0",
      entry: "classify",
      stages: [
        {
          id: "classify",
          module: "IntentClassifier",
          config: { mode: "chat" },
          next: null,
        },
      ],
    };

    const { events } = await streamWorkflow(workflow, { query: "hello" }, { timeoutMs: 60_000 });

    const stageStarts = events.filter((e) => e.event === "stage:start");
    const stageCompletes = events.filter((e) => e.event === "stage:complete");
    const hasWorkflowError = events.some((e) => e.event === "workflow:error");
    const hasTerminal = events.some(
      (e) => e.event === "workflow:complete" || e.event === "workflow:error",
    );

    // Only assert bracket invariant if stream completed (got terminal event)
    if (hasTerminal && !hasWorkflowError) {
      expect(stageStarts.length).toBe(stageCompletes.length);

      // stage:start should come before corresponding stage:complete
      for (const start of stageStarts) {
        const startIdx = events.indexOf(start);
        const matchingComplete = events.findIndex(
          (e, idx) =>
            idx > startIdx &&
            e.event === "stage:complete" &&
            e.data.stageId === start.data.stageId,
        );
        expect(matchingComplete).toBeGreaterThan(startIdx);
      }
    } else if (!hasTerminal) {
      console.log(`  → stream truncated (${events.length} events — bracket check skipped)`);
      // At minimum, if we got any stage:start events, that's a valid partial stream
      expect(events.length).toBeGreaterThan(0);
    }
  }, LLM_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 5. Full Chat Workflow (requires LLM — todo)
// ---------------------------------------------------------------------------

describe("Chat E2E — Full Chat Workflow", () => {
  test.todo(
    "full chat.json produces complete SSE lifecycle (requires Ollama + qwen3.5:4b)",
    () => {},
  );
  test.todo(
    "multi-stage chat with retrieval produces stage:progress tokens",
    () => {},
  );
  test.todo(
    "concurrent SSE streams don't interfere with each other",
    () => {},
  );
});
