/**
 * MCP Tool Helpers — shared utilities for MCP tool handlers
 */

import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import type { GlobalConfig, WorkflowData } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { MemgraphClient } from "../../providers/MemgraphClient.js";

// ---------------------------------------------------------------------------
// Workflow execution helper
// ---------------------------------------------------------------------------

export async function runServiceWorkflow(
  workflowConfig: unknown,
  input: Partial<WorkflowData>,
  globalConfig: GlobalConfig,
): Promise<WorkflowData> {
  const engine = new WorkflowEngine(workflowConfig as any);
  await engine.initialize(globalConfig);
  try {
    const state = await engine.run(input);
    return state.data;
  } finally {
    await engine.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Memgraph direct access helper
// ---------------------------------------------------------------------------

export interface MemgraphDirectResult {
  records: Record<string, unknown>[];
}

export async function withMemgraph<T>(
  globalConfig: GlobalConfig,
  fn: (client: MemgraphClient) => Promise<T>,
): Promise<T> {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const client = new MemgraphClient(
    {
      uri: globalConfig.memgraphUri ?? process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
      user: globalConfig.memgraphUser ?? process.env.MEMGRAPH_USER ?? "memgraph",
      password: globalConfig.memgraphPassword ?? process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    },
    logger as any,
  );

  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Content formatting
// ---------------------------------------------------------------------------

export function formatAsJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
