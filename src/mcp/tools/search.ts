/**
 * memflow_search — raw hybrid search without LLM generation
 *
 * Runs the service-search workflow: query translation → hybrid retrieval.
 * Returns raw chunks, memories, and graph paths.
 */

import type { GlobalConfig } from "../../core/types.js";
import { runServiceWorkflow } from "./_helpers.js";
import searchWorkflow from "../../workflows/service/search.json" with { type: "json" };

export interface SearchArgs {
  query: string;
  topK?: number;
  tenantId?: string;
}

export async function handleSearch(args: Record<string, unknown>, globalConfig: GlobalConfig) {
  const query = args.query as string;
  const topK = args.topK as number | undefined;
  const tenantId = args.tenantId as string | undefined;

  if (!query || typeof query !== "string") {
    throw new Error("Missing required argument: query (string)");
  }

  const config = tenantId ? { ...globalConfig, tenantId } : globalConfig;

  const data = await runServiceWorkflow(
    searchWorkflow,
    { query },
    config,
  );

  const result = data.retrievalResult;

  return {
    chunks: result?.chunks?.map((c) => ({
      content: c.pageContent,
      metadata: c.metadata,
    })) ?? [],
    memories: result?.memories?.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      timestamp: m.timestamp,
    })) ?? [],
    score: result?.score ?? 0,
    sources: result?.sources ?? [],
  };
}
