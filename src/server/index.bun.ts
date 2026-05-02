/**
 * MemFlow Server — Bun runtime entry point
 *
 * Uses Bun.serve() for native high-performance HTTP serving.
 */

import { createServer } from "./index.js";
import type { GlobalConfig } from "../core/types.js";

export async function startBunServer(
  port = Number(process.env.PORT ?? 3000),
  globalConfig: GlobalConfig = {},
): Promise<void> {
  const app = createServer(globalConfig);

  console.log(`
╔══════════════════════════════════════╗
║         MemFlow v0.4.0               ║
║  Self-Improving RAG Workflow Engine  ║
║  Runtime: Bun                        ║
╚══════════════════════════════════════╝

  HTTP server:  http://localhost:${port}
  Health:       http://localhost:${port}/health
  Metrics:      http://localhost:${port}/metrics
  Modules:      http://localhost:${port}/modules
  Run workflow:  POST http://localhost:${port}/workflow/run
  Run (stream):  POST http://localhost:${port}/workflow/run/stream
`);

  Bun.serve({
    fetch: app.fetch,
    port,
  });
}
