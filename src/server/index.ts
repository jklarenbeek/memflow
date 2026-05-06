/**
 * MemFlow HTTP Server
 *
 * Hono-based API server ported from HRW's pattern. Provides:
 *  - GET  /health               — service health + registered modules
 *  - POST /workflow/run          — execute a workflow from JSON config + input
 *  - POST /workflow/run/stream   — execute with SSE streaming (Improvement #9)
 *  - GET  /modules              — list available modules with schemas
 *  - GET  /prompts/validate     — validate TOML prompt references
 *  - POST /prompts/reload       — invalidate TOML prompt cache
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { WorkflowEngine } from "../core/WorkflowEngine.js";
import { ModuleRegistry } from "../core/ModuleRegistry.js";
import type { WorkflowConfig, GlobalConfig } from "../core/types.js";
import { clearPromptCache, validateAllPrompts } from "../utils/promptLoader.js";
import { metricsHandler, wireEngineMetrics } from "./metrics.js";
import { getMemgraphPool } from "./db.js";
import { mountMCPRoutes } from "./mcp.js";
import { createAPIRouter } from "./api.js";
import { mountACPRoutes } from "./acp.js";

export function createServer(globalConfig: GlobalConfig = {}): Hono {
  const app = new Hono();
  const registry = ModuleRegistry.getInstance();

  app.use("/*", cors());

  // Health check
  app.get("/health", async (c) => {
    // Lightweight dependency checks
    const checks: Record<string, string> = {};

    // Memgraph
    try {
      const mg = getMemgraphPool(globalConfig);
      await mg.query("RETURN 1 AS n");
      checks.memgraph = "connected";
    } catch {
      checks.memgraph = "disconnected";
    }

    // Tavily API key
    checks.tavily = process.env.TAVILY_API_KEY ? "configured" : "missing";

    // Ollama reachability
    try {
      const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      checks.ollama = res.ok ? "reachable" : "unreachable";
    } catch {
      checks.ollama = "unreachable";
    }

    const healthy = checks.memgraph === "connected";

    return c.json(
      {
        status: healthy ? "ok" : "degraded",
        service: "memflow",
        version: "0.5.0",
        modules: registry.listModules(),
        checks,
        timestamp: new Date().toISOString(),
      },
      healthy ? 200 : 503,
    );
  });

  // List modules
  // Prometheus metrics endpoint
  app.get("/metrics", metricsHandler);

  app.get("/modules", (c) =>
    c.json({
      modules: registry.listModules(),
    }),
  );

  // Improvement #15: Manual prompt cache invalidation
  app.post("/prompts/reload", (c) => {
    clearPromptCache();
    return c.json({
      success: true,
      message: "TOML prompt cache cleared. Next load will re-read from disk.",
      timestamp: new Date().toISOString(),
    });
  });

  // Improvement #8: Prompt validation endpoint
  app.get("/prompts/validate", (c) => {
    try {
      const result = validateAllPrompts();
      return c.json({
        success: true,
        valid: result.valid.length,
        missing: result.missing,
        parseErrors: result.parseErrors,
        total: result.valid.length + result.missing.length + result.parseErrors.length,
      });
    } catch (err) {
      return c.json(
        { success: false, error: (err as Error).message },
        500,
      );
    }
  });

  // Run workflow
  app.post("/workflow/run", async (c) => {
    try {
      const body = await c.req.json<{
        workflow: WorkflowConfig;
        input?: Record<string, unknown>;
      }>();

      if (!body.workflow) {
        return c.json({ error: "Missing 'workflow' in request body" }, 400);
      }

      const engine = new WorkflowEngine(body.workflow);
      await engine.initialize(globalConfig);

      if (globalConfig.enableMetrics !== false) {
        wireEngineMetrics(engine);
      }

      try {
        const state = await engine.run(body.input ?? {});

        // Improvement #10: Aggregate telemetry from all stages
        const telemetry = {
          tokenUsage: 0,
          memgraphQueries: 0,
          embeddingCalls: 0,
        };
        for (const entry of state.history) {
          const stageMetrics = (entry.output as Record<string, unknown>)?.metrics as Record<string, unknown> | undefined;
          if (stageMetrics) {
            telemetry.tokenUsage += Number(stageMetrics.tokenUsage ?? 0);
            telemetry.memgraphQueries += Number(stageMetrics.memgraphQueries ?? 0);
            telemetry.embeddingCalls += Number(stageMetrics.embeddingCalls ?? 0);
          }
        }

        return c.json({
          success: true,
          workflowId: state.id,
          iterations: state.iteration + 1,
          history: state.history,
          data: {
            finalAnswer: state.data.finalAnswer,
            confidence: state.data.confidence,
            sources: state.data.sources,
          },
          metrics: state.data.metrics,
          telemetry,
          errors: state.errors,
        });
      } finally {
        await engine.shutdown();
      }
    } catch (err) {
      const error = err as Error;
      return c.json(
        {
          success: false,
          error: error.message,
          code: (error as Error & { code?: string }).code ?? "UNKNOWN",
        },
        500,
      );
    }
  });

  // -----------------------------------------------------------------------
  // MCP Server (Model Context Protocol)
  // -----------------------------------------------------------------------
  mountMCPRoutes(app, globalConfig);

  // -----------------------------------------------------------------------
  // Direct REST API
  // -----------------------------------------------------------------------
  app.route("/api/v1", createAPIRouter(globalConfig));

  // -----------------------------------------------------------------------
  // ACP Server (Agent Client Protocol)
  // -----------------------------------------------------------------------
  mountACPRoutes(app, globalConfig);

  // -----------------------------------------------------------------------
  // Improvement #9: Streaming workflow execution via SSE
  // -----------------------------------------------------------------------

  app.post("/workflow/run/stream", async (c) => {
    // Parse the request body BEFORE entering the stream callback
    // (Hono's streamSSE doesn't allow async body reads inside the callback)
    let body: { workflow: WorkflowConfig; input?: Record<string, unknown>; tempFilePath?: string };
    try {
      body = await c.req.json<{
        workflow: WorkflowConfig;
        input?: Record<string, unknown>;
        tempFilePath?: string;
      }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.workflow) {
      return c.json({ error: "Missing 'workflow' in request body" }, 400);
    }

    // Disable proxy buffering for real-time streaming
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache");

    let engine: WorkflowEngine | null = null;

    return streamSSE(c, async (stream) => {
      let eventId = 0;

      try {
        engine = new WorkflowEngine(body.workflow);
        await engine.initialize(globalConfig);

        if (globalConfig.enableMetrics !== false) {
          wireEngineMetrics(engine);
        }

        // Create an AbortController for client disconnect handling
        const abortController = new AbortController();
        stream.onAbort(() => {
          abortController.abort();
        });

        // Consume the AsyncGenerator and write each event as SSE
        // Start a keepalive ping to prevent idle timeout during long-running stages
        const keepaliveInterval = setInterval(async () => {
          if (!stream.aborted) {
            try {
              await stream.writeSSE({
                id: String(eventId++),
                event: "keepalive",
                data: JSON.stringify({ type: "keepalive", timestamp: new Date().toISOString() }),
              });
            } catch { /* stream may have closed */ }
          }
        }, 30_000);

        const generator = engine.runStream(
          body.input ?? {},
          abortController.signal,
        );

        try {
          let result = await generator.next();
          while (!result.done) {
            if (stream.aborted) break;

            const event = result.value;
            await stream.writeSSE({
              id: String(eventId++),
              event: event.type,
              data: JSON.stringify(event),
            });

            result = await generator.next();
          }
        } finally {
          clearInterval(keepaliveInterval);
        }

        // If the generator returned a final state (workflow:complete path)
        // the events are already emitted via the generator
      } catch (err) {
        // Emit an error event for unexpected failures
        if (!stream.aborted) {
          await stream.writeSSE({
            id: String(eventId++),
            event: "workflow:error",
            data: JSON.stringify({
              type: "workflow:error",
              workflowId: "unknown",
              error: (err as Error).message,
              timestamp: new Date().toISOString(),
            }),
          });
        }
      } finally {
        // Always shut down the engine
        if (engine) {
          await engine.shutdown();
        }
        // Clean up temp files from ingestion uploads
        if (body.tempFilePath) {
          const { unlink } = await import("fs/promises");
          unlink(body.tempFilePath).catch(() => { /* best-effort cleanup */ });
        }
      }
    });
  });

  return app;
}

export async function startServer(
  port = Number(process.env.PORT ?? 3000),
  globalConfig: GlobalConfig = {},
): Promise<void> {
  // Auto-detect runtime and delegate to the appropriate server implementation
  if (typeof globalThis.Bun !== "undefined") {
    const { startBunServer } = await import("./index.bun.js");
    await startBunServer(port, globalConfig);
  } else {
    const { startNodeServer } = await import("./index.node.js");
    await startNodeServer(port, globalConfig);
  }
}
