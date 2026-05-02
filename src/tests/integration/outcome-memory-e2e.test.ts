/**
 * Outcome Memory E2E Integration Tests
 *
 * Validates the full two-phase outcome lifecycle:
 *   1. Log pending proposal → KG (:PendingDecision)
 *   2. Resolve with outcome → KG (:Decision + :Reflection)
 *   3. Reflection generation via LLM
 *   4. Context injection into subsequent workflow
 *
 * Uses mock context (no live Memgraph or LLM).
 */

import { describe, it, expect } from "bun:test";
import { OutcomeMemoryModule } from "../../gmpl/modules/OutcomeMemoryModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";
import type { PendingDecision } from "../../gmpl/types.js";

describe("OutcomeMemory E2E Lifecycle", () => {
  // -----------------------------------------------------------------------
  // Phase 1 → Phase 2 → Injection: full lifecycle
  // -----------------------------------------------------------------------

  it("should execute the full two-phase lifecycle", async () => {
    // Step 1: Log pending proposal
    const { ctx: ctx1, mocks: mocks1 } = createMockContext();
    const mod1 = new OutcomeMemoryModule({ twoPhaseEnabled: true });
    await mod1.init(ctx1);

    const pending: PendingDecision = {
      id: "lifecycle-test-1",
      patternId: "structured_debate",
      domainId: "trading",
      content: "Buy AAPL based on strong Q4 earnings beat (EPS $1.64 vs $1.60 est)",
      entityIds: [],
      timestamp: new Date().toISOString(),
      resolveBefore: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const logOutput = await mod1.process(buildInput({ pendingDecision: pending }), ctx1);

    expect(logOutput.metrics?.mode).toBe("log_pending");
    expect(logOutput.data.pendingDecision).toBeDefined();

    // Verify KG write for PendingDecision
    const createQueries = mocks1.memgraph._queries
      .map((q: { cypher: string }) => q.cypher)
      .filter((c: string) => c.includes("PendingDecision"));
    expect(createQueries.length).toBeGreaterThan(0);

    // Step 2: Resolve with outcome (simulate time passing)
    const reflectionText =
      "The AAPL earnings thesis was correct — EPS beat drove 8% return. " +
      "However, the magnitude was underestimated. Future analyses should " +
      "weight services revenue growth more heavily in P/E estimates.";

    const { ctx: ctx2 } = createMockContext({
      llm: { responses: [reflectionText] },
      memgraph: {
        queryResults: {
          PendingDecision: [{ content: "Buy AAPL based on strong Q4 earnings beat" }],
        },
      },
    });

    const mod2 = new OutcomeMemoryModule({});
    await mod2.init(ctx2);

    const resolveOutput = await mod2.process(
      buildInput({
        outcomeResolution: {
          pendingId: "lifecycle-test-1",
          result: {
            raw: { actualReturn: 0.08, predictedReturn: 0.05 },
            outcome: "success",
            summary: "8% return vs 5% predicted. Direction correct.",
          },
        },
      }),
      ctx2,
    );

    expect(resolveOutput.metrics?.mode).toBe("resolve");
    expect(resolveOutput.data.outcomeResolution).toBeDefined();

    // Step 3: Inject context into new workflow
    const { ctx: ctx3 } = createMockContext({
      memgraph: {
        queryResults: {
          Decision: [
            {
              content: "Buy AAPL based on strong Q4 earnings beat",
              outcome: "success",
              reflection: reflectionText,
            },
          ],
        },
      },
    });

    const mod3 = new OutcomeMemoryModule({});
    const injectOutput = await mod3.process(
      buildInput({ outcomeContext: "__request__" }),
      ctx3,
    );

    expect(injectOutput.metrics?.mode).toBe("inject");
    expect(typeof injectOutput.data.outcomeContext).toBe("string");
    expect((injectOutput.data.outcomeContext as string).length).toBeGreaterThan(0);
    expect(injectOutput.data.outcomeContext).toContain("success");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("should handle resolution for nonexistent pending decision", async () => {
    const { ctx } = createMockContext({
      memgraph: { queryResults: {} },
    });

    const mod = new OutcomeMemoryModule({});
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        outcomeResolution: {
          pendingId: "nonexistent-id",
          result: { raw: {}, outcome: "failure", summary: "test" },
        },
      }),
      ctx,
    );

    expect(output.metrics?.mode).toBe("resolve");
    // Should not crash — graceful fallback
  });

  it("should return empty context when no decisions exist", async () => {
    const { ctx } = createMockContext({
      memgraph: { queryResults: {} },
    });

    const mod = new OutcomeMemoryModule({});
    const output = await mod.process(
      buildInput({ outcomeContext: "__request__" }),
      ctx,
    );

    expect(output.metrics?.mode).toBe("inject");
    expect(output.data.outcomeContext).toBe("");
  });

  it("should handle LLM failure during reflection gracefully", async () => {
    const { ctx } = createMockContext({
      llm: { shouldFail: true },
      memgraph: {
        queryResults: {
          PendingDecision: [{ content: "Buy AAPL" }],
        },
      },
    });

    const mod = new OutcomeMemoryModule({});
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        outcomeResolution: {
          pendingId: "test-llm-fail",
          result: { raw: {}, outcome: "partial", summary: "5% return" },
        },
      }),
      ctx,
    );

    // Should fallback to summary-based reflection, not crash
    expect(output.metrics?.mode).toBe("resolve");
  });
});
