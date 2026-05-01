/**
 * MemFlow HTTP Server
 *
 * Hono-based API server ported from HRW's pattern. Provides:
 *  - GET  /health     — service health + registered modules
 *  - POST /workflow/run — execute a workflow from JSON config + input
 *  - GET  /modules    — list available modules with schemas
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { WorkflowEngine } from "../core/WorkflowEngine.js";
import { ModuleRegistry } from "../core/ModuleRegistry.js";
import type { WorkflowConfig, GlobalConfig } from "../core/types.js";
import { clearPromptCache, validateAllPrompts } from "../utils/promptLoader.js";

export function createServer(globalConfig: GlobalConfig = {}): Hono {
  const app = new Hono();
  const registry = ModuleRegistry.getInstance();

  app.use("/*", cors());

  // Health check
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "memflow",
      version: "0.4.0",
      modules: registry.listModules(),
      timestamp: new Date().toISOString(),
    }),
  );

  // List modules
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
          code: (error as any).code ?? "UNKNOWN",
        },
        500,
      );
    }
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
