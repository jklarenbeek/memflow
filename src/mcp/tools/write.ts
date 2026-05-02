/**
 * memflow_write — ingest memory content into MemFlow
 *
 * Runs the service-ingest workflow: chunk → extract facts → persist to graph.
 */

import type { GlobalConfig } from "../../core/types.js";
import { runServiceWorkflow } from "./_helpers.js";
import ingestWorkflow from "../../workflows/service/ingest.json" with { type: "json" };

export interface WriteArgs {
  content: string;
  tenantId?: string;
}

export async function handleWrite(args: Record<string, unknown>, globalConfig: GlobalConfig) {
  const content = args.content as string;
  const tenantId = args.tenantId as string | undefined;

  if (!content || typeof content !== "string") {
    throw new Error("Missing required argument: content (string)");
  }

  const config = tenantId ? { ...globalConfig, tenantId } : globalConfig;

  const data = await runServiceWorkflow(
    ingestWorkflow,
    {
      query: content,
      documents: [{ pageContent: content, metadata: { source: "mcp-write" } }],
    },
    config,
  );

  const memoryUnits = data.memoryUnits ?? [];
  const memoryIds = memoryUnits.map((u) => u.id);

  return {
    memoryIds,
    count: memoryUnits.length,
    preview: memoryUnits.map((u) => u.content).slice(0, 3),
  };
}
