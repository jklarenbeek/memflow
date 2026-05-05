/**
 * MCP Tool Helpers — shared utilities for MCP tool handlers
 */

import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import type { GlobalConfig, WorkflowData } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { MemgraphClient } from "../../providers/MemgraphClient.js";
import { getMemgraphPool } from "../../server/db.js";

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

/**
 * Borrows the singleton MemgraphClient from the connection pool.
 * The connection is NOT closed after use — it's shared across all requests.
 */
export async function withMemgraph<T>(
  globalConfig: GlobalConfig,
  fn: (client: MemgraphClient) => Promise<T>,
): Promise<T> {
  const client = getMemgraphPool(globalConfig);
  return fn(client);
}

// ---------------------------------------------------------------------------
// Content formatting
// ---------------------------------------------------------------------------

export function formatAsJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
