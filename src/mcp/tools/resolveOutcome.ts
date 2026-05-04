/**
 * gmpl_resolve_outcome — MCP tool to resolve a pending decision with outcome
 *
 * Wraps the OutcomeMemoryModule's resolution flow:
 *   1. Looks up the pending decision by ID
 *   2. Optionally uses the domain adapter's outcomeEvaluator
 *   3. Resolves via OutcomeMemoryModule (creates Decision + Reflection nodes)
 *   4. Returns the reflection and outcome details
 *
 * This enables external systems (trading bots, monitoring agents, etc.)
 * to close the feedback loop on decisions made by GMPL patterns.
 */

import { OutcomeMemoryModule } from "../../gmpl/modules/OutcomeMemoryModule.js";
import { DomainRegistry } from "../../gmpl/DomainRegistry.js";
import { withMemgraph, formatAsJson } from "./_helpers.js";
import type { GlobalConfig } from "../../core/types.js";
import type { OutcomeResult, PendingDecision } from "../../gmpl/types.js";

/**
 * MCP tool handler for `gmpl_resolve_outcome`.
 *
 * Expected arguments:
 *   - pendingId: string — ID of the pending decision to resolve
 *   - outcome: "success" | "failure" | "partial" — outcome classification
 *   - summary: string — human-readable outcome summary
 *   - metrics: object (optional) — domain-specific metrics
 *   - tenantId: string (optional) — tenant ID for domain adapter lookup
 *   - evaluatorContext: object (optional) — context passed to domain adapter's outcomeEvaluator
 */
export async function handleResolveOutcome(
  args: Record<string, unknown>,
  globalConfig?: GlobalConfig,
): Promise<Record<string, unknown>> {
  const pendingId = args.pendingId as string;
  const outcome = args.outcome as string;
  const summary = args.summary as string;
  const metrics = (args.metrics as Record<string, unknown>) ?? {};
  const tenantId = (args.tenantId as string) ?? globalConfig?.tenantId;
  const evaluatorContext = (args.evaluatorContext as Record<string, unknown>) ?? {};

  if (!pendingId) {
    return { error: "Missing required argument: pendingId" };
  }
  if (!outcome || !["success", "failure", "partial"].includes(outcome)) {
    return { error: "Invalid outcome. Must be one of: success, failure, partial" };
  }
  if (!summary) {
    return { error: "Missing required argument: summary" };
  }

  // Build outcome result — optionally use domain adapter's evaluator
  let outcomeResult: OutcomeResult;

  if (tenantId && Object.keys(evaluatorContext).length > 0) {
    try {
      const registry = DomainRegistry.getInstance();
      const adapter = registry.get(tenantId);

      if (adapter?.outcomeEvaluator) {
        // Use the domain adapter's evaluator for richer outcome classification
        const pendingStub: PendingDecision = {
          id: pendingId,
          patternId: (evaluatorContext.patternId as string) ?? "unknown",
          content: (evaluatorContext.content as string) ?? "",
          entityIds: [],
          timestamp: new Date().toISOString(),
        };

        outcomeResult = await adapter.outcomeEvaluator(pendingStub, evaluatorContext);
      } else {
        outcomeResult = buildManualOutcome(outcome, summary, metrics);
      }
    } catch (err) {
      // Fall back to manual outcome if adapter evaluation fails
      outcomeResult = buildManualOutcome(outcome, summary, metrics);
    }
  } else {
    outcomeResult = buildManualOutcome(outcome, summary, metrics);
  }

  // Execute resolution via OutcomeMemoryModule
  try {
    const module = new OutcomeMemoryModule({});
    const result = await withMemgraphContext(module, pendingId, outcomeResult, globalConfig ?? {});

    return {
      pendingId,
      outcome: outcomeResult.outcome,
      summary: outcomeResult.summary,
      reflection: result.reflection,
      resolved: true,
    };
  } catch (err) {
    return {
      error: `Outcome resolution failed: ${(err as Error).message}`,
      pendingId,
    };
  }
}

/**
 * Build a manual OutcomeResult from explicit tool arguments.
 */
function buildManualOutcome(
  outcome: string,
  summary: string,
  metrics: Record<string, unknown>,
): OutcomeResult {
  return {
    raw: metrics,
    outcome: outcome as "success" | "failure" | "partial",
    summary,
    metrics,
  };
}

/**
 * Execute OutcomeMemoryModule resolution with a temporary WorkflowContext.
 *
 * This creates a minimal context to drive the module's KG operations.
 */
async function withMemgraphContext(
  module: OutcomeMemoryModule,
  pendingId: string,
  outcomeResult: OutcomeResult,
  globalConfig: GlobalConfig,
): Promise<{ reflection: string }> {
  return withMemgraph(globalConfig, async (client) => {
    // Create a minimal WorkflowContext-like object for the module
    const minimalContext = {
      memgraph: client,
      logger: {
        info: (...args: unknown[]) => {},
        warn: (...args: unknown[]) => {},
        error: (...args: unknown[]) => {},
        debug: (...args: unknown[]) => {},
      },
      getLLM: () => {
        throw new Error("LLM not available in MCP context — reflection will use fallback");
      },
      globalConfig,
      eventEmitter: { emit: () => {} },
    };

    const result = await module.process(
      {
        data: {
          outcomeResolution: {
            pendingId,
            result: outcomeResult,
          },
        },
        config: {} as any,
      },
      minimalContext,
    );

    const resolution = result.data.outcomeResolution as { reflection: string } | undefined;
    return { reflection: resolution?.reflection ?? "" };
  });
}
