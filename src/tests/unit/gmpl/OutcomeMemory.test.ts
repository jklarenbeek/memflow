import { describe, it, expect } from "bun:test";
import { OutcomeMemoryModule } from "../../../gmpl/modules/OutcomeMemoryModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";
import type { PendingDecision } from "../../../gmpl/types.js";

describe("OutcomeMemoryModule", () => {
  it("should log a pending proposal to KG", async () => {
    const { ctx, mocks } = createMockContext();

    const mod = new OutcomeMemoryModule({ twoPhaseEnabled: true });
    await mod.init(ctx);

    const pending: PendingDecision = {
      id: "test-pending-1",
      patternId: "structured_debate",
      content: "Buy AAPL based on strong earnings",
      entityIds: [],
      timestamp: new Date().toISOString(),
    };

    const output = await mod.process(
      buildInput({ pendingDecision: pending }),
      ctx,
    );

    expect(output.metrics?.mode).toBe("log_pending");
    // Verify KG was called
    expect(mocks.memgraph._queryCount()).toBeGreaterThan(0);
    const queries = mocks.memgraph._queries.map((q: any) => q.cypher);
    expect(queries.some((q: string) => q.includes("PendingDecision"))).toBe(true);
  });

  it("should resolve with outcome and generate reflection", async () => {
    const { ctx, mocks } = createMockContext({
      llm: { responses: ["The decision was partially correct. Earnings were strong but rate concerns materialized."] },
      memgraph: {
        queryResults: {
          "PendingDecision": [{ content: "Buy AAPL" }],
        },
      },
    });

    const mod = new OutcomeMemoryModule({});
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        outcomeResolution: {
          pendingId: "test-pending-1",
          result: { raw: { returns: 0.05 }, outcome: "partial", summary: "5% return vs 10% expected" },
        },
      }),
      ctx,
    );

    expect(output.metrics?.mode).toBe("resolve");
  });

  it("should retrieve augmented context", async () => {
    const { ctx } = createMockContext({
      memgraph: {
        queryResults: {
          "Decision": [
            { content: "Buy AAPL", outcome: "success", reflection: "Strong earnings thesis was correct" },
          ],
        },
      },
    });

    const mod = new OutcomeMemoryModule({});
    const output = await mod.process(
      buildInput({ outcomeContext: "__request__" }),
      ctx,
    );

    expect(output.metrics?.mode).toBe("inject");
    expect(output.data.outcomeContext).toBeDefined();
  });

  it("should noop when no relevant data is present", async () => {
    const { ctx } = createMockContext();
    const mod = new OutcomeMemoryModule({});
    const output = await mod.process(buildInput({}), ctx);
    expect(output.metrics?.mode).toBe("noop");
  });

  it("should lazily create KG indexes in init()", async () => {
    const { ctx, mocks } = createMockContext();
    const mod = new OutcomeMemoryModule({});
    await mod.init(ctx);

    const queries = mocks.memgraph._queries.map((q: any) => q.cypher);
    expect(queries.some((q: string) => q.includes("CREATE INDEX"))).toBe(true);
  });
});
