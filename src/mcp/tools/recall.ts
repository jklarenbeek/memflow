/**
 * memflow_recall — search memories and generate an LLM brief
 *
 * Runs the service-recall workflow: query translation → hybrid retrieval → answer generation.
 */

import type { GlobalConfig } from "../../core/types.js";
import { runServiceWorkflow } from "./_helpers.js";
import recallWorkflow from "../../workflows/service/recall.json" with { type: "json" };

export interface RecallArgs {
  query: string;
  tenantId?: string;
}

export async function handleRecall(args: Record<string, unknown>, globalConfig: GlobalConfig) {
  const query = args.query as string;
  const tenantId = args.tenantId as string | undefined;

  if (!query || typeof query !== "string") {
    throw new Error("Missing required argument: query (string)");
  }

  const config = tenantId ? { ...globalConfig, tenantId } : globalConfig;

  const data = await runServiceWorkflow(
    recallWorkflow,
    { query },
    config,
  );

  return {
    answer: data.finalAnswer ?? "No answer generated.",
    sources: data.sources ?? [],
    confidence: data.confidence ?? 0,
  };
}
