/**
 * MemFlow Server — Node.js runtime entry point
 *
 * Uses the `serve` helper from `@hono/node-server` for Node.js compatibility.
 * Falls back to raw `node:http` if the Hono node adapter is not available.
 */

import { createServer } from "./index.js";
import { shutdownPool } from "./db.js";
import type { GlobalConfig } from "../core/types.js";

export async function startNodeServer(
  port = Number(process.env.PORT ?? 3000),
  globalConfig: GlobalConfig = {},
): Promise<void> {
  const app = createServer(globalConfig);

  console.log(`
╔══════════════════════════════════════╗
║         MemFlow v0.5.0               ║
║  Self-Improving RAG Workflow Engine  ║
║  Runtime: Node.js                    ║
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

  try {
    // Prefer @hono/node-server for production-grade serving
    const { serve } = await import("@hono/node-server");
    serve({ fetch: app.fetch, port });
  } catch {
    // Fallback: raw node:http adapter
    const http = await import("node:http");
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
      }

      const body = req.method !== "GET" && req.method !== "HEAD"
        ? await new Promise<string>((resolve) => {
            let data = "";
            req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            req.on("end", () => resolve(data));
          })
        : undefined;

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });

    server.listen(port, () => {
      console.log(`  Node.js HTTP server listening on port ${port}`);
    });
  }

  // Graceful shutdown — close the Memgraph connection pool
  const shutdown = async () => {
    console.log("\n[memflow] Shutting down...");
    await shutdownPool();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
