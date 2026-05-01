/**
 * MemFlow Entrypoint
 *
 * Supports two modes:
 *  - Server mode (default): starts Hono HTTP server
 *  - CLI mode: runs a workflow JSON file directly
 *
 * Usage:
 *   bun run start                     → HTTP server on :3000
 *   bun run src/index.ts run workflow.json --input '{"query": "..."}'
 */

import { startServer } from "./server/index.js";
import { WorkflowEngine } from "./core/WorkflowEngine.js";
import type { GlobalConfig } from "./core/types.js";
import fs from "fs/promises";

const globalConfig: GlobalConfig = {
  llmProvider: (process.env.LLM_PROVIDER as GlobalConfig["llmProvider"]) ?? "ollama",
  llmModel: process.env.LLM_MODEL,
  embeddingProvider:
    (process.env.EMBEDDING_PROVIDER as GlobalConfig["embeddingProvider"]) ?? "ollama",
  embeddingModel: process.env.EMBEDDING_MODEL,
  memgraphUri: process.env.MEMGRAPH_URI,
  memgraphUser: process.env.MEMGRAPH_USER,
  memgraphPassword: process.env.MEMGRAPH_PASSWORD,
  logLevel: (process.env.LOG_LEVEL as GlobalConfig["logLevel"]) ?? "info",
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "run" && args[1]) {
    // CLI mode: run a workflow file
    const workflowPath = args[1];
    const inputArg = args.find((a) => a.startsWith("--input="));
    const input = inputArg
      ? JSON.parse(inputArg.split("=").slice(1).join("="))
      : {};

    const workflowJson = JSON.parse(
      await fs.readFile(workflowPath, "utf-8"),
    );
    const engine = new WorkflowEngine(workflowJson);
    await engine.initialize(globalConfig);

    try {
      const state = await engine.run(input);
      console.log("\n=== Workflow Complete ===");
      console.log(
        `Final answer: ${(state.data.finalAnswer as string)?.substring(0, 500) ?? "N/A"}`,
      );
      console.log(`Iterations: ${state.iteration + 1}`);
      console.log(`Metrics:`, state.data.metrics);
      if (state.errors.length > 0) {
        console.warn(`Errors:`, state.errors);
      }
    } finally {
      await engine.shutdown();
    }
  } else {
    // Server mode (default)
    const port = Number(process.env.PORT ?? 3000);
    await startServer(port, globalConfig);
  }
}

main().catch((err) => {
  console.error("MemFlow fatal error:", err);
  process.exit(1);
});