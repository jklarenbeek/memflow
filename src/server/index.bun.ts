/**
 * MemFlow Server — Bun runtime entry point
 *
 * Uses Bun.serve() for native high-performance HTTP serving.
 */

import { createServer } from "./index.js";
import { shutdownPool } from "./db.js";
import type { GlobalConfig } from "../core/types.js";

export async function startBunServer(
  port = Number(process.env.PORT ?? 3000),
  globalConfig: GlobalConfig = {},
): Promise<void> {
  const app = createServer(globalConfig);

  console.log(`
╔══════════════════════════════════════╗
║         MemFlow v0.5.0               ║
║  Self-Improving RAG Workflow Engine  ║
║  Runtime: Bun                        ║
╚══════════════════════════════════════╝

  HTTP server:  http://localhost:${port}
  Health:       http://localhost:${port}/health
  Metrics:      http://localhost:${port}/metrics
  MCP:          POST http://localhost:${port}/mcp
  ACP:          POST http://localhost:${port}/acp
  REST API:     http://localhost:${port}/api/v1
  Modules:      http://localhost:${port}/modules
  Run workflow:  POST http://localhost:${port}/workflow/run
  Run (stream):  POST http://localhost:${port}/workflow/run/stream
`);

  Bun.serve({
    fetch: app.fetch,
    port,
  });

  // Graceful shutdown — close the Memgraph connection pool
  const shutdown = async () => {
    console.log("\n[memflow] Shutting down...");
    await shutdownPool();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
