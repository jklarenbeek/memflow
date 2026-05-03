/**
 * gmpl_run_pattern — MCP tool to execute a GMPL pattern
 *
 * Resolves a pattern from PatternRegistry, validates input against the
 * pattern's inputContract, builds a workflow via PatternComposer's
 * generateWorkflow(), executes it, and returns the result.
 *
 * Designed to be called by external MCP clients (e.g., Claude Desktop,
 * Cursor, or other AI agents) to leverage GMPL patterns on-demand.
 */

import { PatternRegistry } from "../../gmpl/PatternRegistry.js";
import { generateWorkflow } from "../../gmpl/PatternComposer.js";
import { runServiceWorkflow, formatAsJson } from "./_helpers.js";
import type { GlobalConfig } from "../../core/types.js";

/**
 * MCP tool handler for `gmpl_run_pattern`.
 *
 * Expected arguments:
 *   - patternId: string — ID of the pattern to execute (e.g., "structured_debate")
 *   - query: string — The query/topic for the pattern
 *   - config: object (optional) — Pattern-specific config overrides
 *   - tenantId: string (optional) — Tenant ID for domain isolation
 */
export async function handleRunPattern(
  args: Record<string, unknown>,
  globalConfig?: GlobalConfig,
): Promise<Record<string, unknown>> {
  const patternId = args.patternId as string;
  const query = args.query as string;
  const configOverrides = (args.config as Record<string, unknown>) ?? {};
  const tenantId = (args.tenantId as string) ?? globalConfig?.tenantId;

  if (!patternId) {
    return { error: "Missing required argument: patternId" };
  }
  if (!query) {
    return { error: "Missing required argument: query" };
  }

  // Resolve pattern from registry
  const registry = PatternRegistry.getInstance();
  const pattern = registry.get(patternId);

  if (!pattern) {
    const available = registry.list().join(", ");
    return {
      error: `Pattern "${patternId}" not found. Available patterns: ${available}`,
    };
  }

  // Validate input against the pattern's contract
  const inputValidation = pattern.inputContract.safeParse({ query });
  if (!inputValidation.success) {
    return {
      error: `Input validation failed for pattern "${patternId}"`,
      details: inputValidation.error.issues.map((i) => i.message),
    };
  }

  // Validate config overrides against the pattern's schema
  try {
    pattern.configSchema.parse(configOverrides);
  } catch (err) {
    return {
      error: `Config validation failed for pattern "${patternId}"`,
      details: (err as Error).message,
    };
  }

  // Generate workflow from pattern using PatternComposer
  const workflowConfig = generateWorkflow({
    name: `mcp-${patternId}`,
    domain: tenantId,
    stages: [
      {
        id: patternId,
        pattern: patternId,
        config: configOverrides,
      },
    ],
  });

  // Execute the workflow
  try {
    const result = await runServiceWorkflow(
      workflowConfig,
      { query },
      {
        ...globalConfig,
        ...(tenantId && { tenantId }),
      },
    );

    return {
      patternId,
      query,
      finalAnswer: result.finalAnswer ?? "",
      data: result,
      summary: `Pattern "${patternId}" executed successfully`,
    };
  } catch (err) {
    return {
      error: `Pattern execution failed: ${(err as Error).message}`,
      patternId,
      query,
    };
  }
}
