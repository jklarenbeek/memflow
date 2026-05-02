import { describe, it, expect } from "bun:test";
import { DelphiPanelModule } from "../../../gmpl/modules/DelphiPanelModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("DelphiPanelModule", () => {
  it("should run multi-round polling and converge", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Round 1: 3 panelists with divergent confidence
          '{"response": "Optimistic outlook", "confidence": 0.9, "reasoning": "Strong fundamentals"}',
          '{"response": "Cautious outlook", "confidence": 0.4, "reasoning": "Uncertain macro"}',
          '{"response": "Moderate outlook", "confidence": 0.6, "reasoning": "Mixed signals"}',
          // Round 2: panelists converge after seeing round 1 stats
          '{"response": "Moderately optimistic", "confidence": 0.7, "reasoning": "Revised upward"}',
          '{"response": "Slightly cautious", "confidence": 0.65, "reasoning": "Still uncertain"}',
          '{"response": "Moderate", "confidence": 0.68, "reasoning": "Aligned with group"}',
          // Synthesis
          "The panel reached moderate consensus with a cautiously optimistic outlook.",
        ],
      },
    });

    const mod = new DelphiPanelModule({
      panelSize: 3,
      maxRounds: 5,
      anonymize: true,
      convergenceMetric: "std_dev",
      convergenceThreshold: 0.1,
    });

    const output = await mod.process(
      buildInput({ query: "What is the economic outlook for Q3?" }),
      ctx,
    );

    expect(output.data.delphiPanelState).toBeDefined();
    const state = output.data.delphiPanelState as any;
    expect(state.rounds.length).toBeGreaterThanOrEqual(1);
    expect(output.data.finalAnswer).toBeDefined();
    expect(output.metrics?.convergenceMetric).toBe("std_dev");
  });

  it("should respect anonymization", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"response": "Analysis A", "confidence": 0.7, "reasoning": "R1"}',
          '{"response": "Analysis B", "confidence": 0.7, "reasoning": "R2"}',
          "Synthesis of anonymous responses.",
        ],
      },
    });

    const mod = new DelphiPanelModule({
      panelists: [
        { id: "expert_alice", persona: "economist" },
        { id: "expert_bob", persona: "analyst" },
      ],
      maxRounds: 1,
      anonymize: true,
      convergenceThreshold: 1.0, // Will converge immediately since std_dev of identical values is 0
    });

    const output = await mod.process(
      buildInput({ query: "Test question" }),
      ctx,
    );

    const state = output.data.delphiPanelState as any;
    // Anonymized panelist IDs should not contain original names
    for (const resp of state.rounds[0].responses) {
      expect(resp.panelistId).not.toContain("alice");
      expect(resp.panelistId).not.toContain("bob");
    }
  });

  it("should handle panel member failures", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new DelphiPanelModule({
      panelSize: 3,
      maxRounds: 1,
      convergenceThreshold: 1.0,
    });

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    expect(output.data.delphiPanelState).toBeDefined();
    const state = output.data.delphiPanelState as any;
    expect(state.rounds[0].responses.length).toBe(3);
    // Fallback responses should have default confidence
    expect(state.rounds[0].responses[0].confidence).toBe(0.5);
  });

  it("should support custom convergence functions", async () => {
    // Register a custom convergence metric
    DelphiPanelModule.registerConvergence("always_converged", () => 0);

    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"response": "A", "confidence": 0.1, "reasoning": "R"}',
          '{"response": "B", "confidence": 0.9, "reasoning": "R"}',
          "Synthesis.",
        ],
      },
    });

    const mod = new DelphiPanelModule({
      panelSize: 2,
      maxRounds: 5,
      convergenceMetric: "always_converged",
      convergenceThreshold: 0.5,
    });

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    const state = output.data.delphiPanelState as any;
    // Should converge after round 1 thanks to custom metric
    expect(state.converged).toBe(true);
    expect(state.currentRound).toBe(1);
  });

  it("should terminate at max rounds without convergence", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Round 1: very divergent
          '{"response": "Very high", "confidence": 0.95, "reasoning": "R"}',
          '{"response": "Very low", "confidence": 0.05, "reasoning": "R"}',
          // Round 2: still divergent
          '{"response": "Still high", "confidence": 0.9, "reasoning": "R"}',
          '{"response": "Still low", "confidence": 0.1, "reasoning": "R"}',
          // Round 3: still divergent
          '{"response": "High again", "confidence": 0.9, "reasoning": "R"}',
          '{"response": "Low again", "confidence": 0.1, "reasoning": "R"}',
          // Synthesis
          "Synthesis without convergence.",
        ],
      },
    });

    const mod = new DelphiPanelModule({
      panelSize: 2,
      maxRounds: 3,
      convergenceThreshold: 0.01, // Very strict
    });

    const output = await mod.process(
      buildInput({ query: "Polarizing question" }),
      ctx,
    );

    const state = output.data.delphiPanelState as any;
    expect(state.converged).toBe(false);
    expect(state.currentRound).toBe(3);
  });
});
