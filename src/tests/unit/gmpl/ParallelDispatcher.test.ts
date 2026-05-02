import { describe, it, expect } from "bun:test";
import { ParallelDispatcherModule } from "../../../gmpl/modules/ParallelDispatcherModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("ParallelDispatcherModule", () => {
  it("should dispatch to multiple analysts and merge", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"analysis": "Fundamentals look strong", "confidence": 0.8, "sources": ["SEC filings"], "recommendations": ["Buy"]}',
          '{"analysis": "Technical indicators bearish", "confidence": 0.6, "sources": ["Charts"], "recommendations": ["Wait"]}',
          // Synthesis response
          "Combined analysis: Strong fundamentals but bearish technicals suggest caution.",
        ],
      },
    });

    const mod = new ParallelDispatcherModule({
      analysts: [
        { id: "fundamentals", role: "domain_analyst" },
        { id: "technical", role: "domain_analyst" },
      ],
      mergeStrategy: "ranked_synthesis",
      timeout: "10s",
    });

    const output = await mod.process(
      buildInput({ query: "Analyze AAPL stock" }),
      ctx,
    );

    expect(output.data.analystReports).toBeDefined();
    expect((output.data.analystReports as any[]).length).toBe(2);
    expect(output.data.mergedAnalysis).toBeDefined();
    expect(output.metrics?.dispatched).toBe(2);
    expect(output.metrics?.received).toBe(2);
  });

  it("should handle analyst failures gracefully", async () => {
    let callCount = 0;
    const { ctx, mocks } = createMockContext();
    // Override LLM to fail on first call, succeed on second
    (mocks.llm as any).invoke = async () => {
      callCount++;
      if (callCount === 1) throw new Error("Analyst 1 failed");
      return { content: '{"analysis": "Report 2", "confidence": 0.7, "sources": [], "recommendations": []}' };
    };

    const mod = new ParallelDispatcherModule({
      analysts: [
        { id: "a1", role: "domain_analyst" },
        { id: "a2", role: "domain_analyst" },
      ],
      mergeStrategy: "weighted_average",
    });

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    expect(output.metrics?.dispatched).toBe(2);
    expect(output.metrics?.received).toBe(1); // One failed
    expect((output.data.analystReports as any[]).length).toBe(1);
  });

  it("should return empty when all analysts fail", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new ParallelDispatcherModule({
      analysts: [{ id: "a1", role: "domain_analyst" }],
    });

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    expect(output.metrics?.received).toBe(0);
    expect((output.data.analystReports as any[]).length).toBe(0);
  });

  it("should parse timeout values correctly", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: ['{"analysis": "OK", "confidence": 0.5, "sources": [], "recommendations": []}'],
      },
    });

    // Test that different timeout formats don't crash
    for (const timeout of ["5s", "500ms", "1m"]) {
      const mod = new ParallelDispatcherModule({
        analysts: [{ id: "a1", role: "domain_analyst" }],
        timeout,
      });
      const output = await mod.process(buildInput({ query: "Test" }), ctx);
      expect(output.data.analystReports).toBeDefined();
    }
  });
});
