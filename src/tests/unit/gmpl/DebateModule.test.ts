import { describe, it, expect } from "bun:test";
import { DebateModule } from "../../../gmpl/modules/DebateModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("DebateModule", () => {
  it("should run a 2-round debate and produce consensus", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Round 1: bull position
          '{"stance": "Markets will rise due to strong earnings", "evidence": ["Q3 earnings beat"], "confidence": 0.8}',
          // Round 1: bear position
          '{"stance": "Markets will fall due to rate hikes", "evidence": ["Fed hawkish stance"], "confidence": 0.7}',
          // Round 1: judge decision (continue)
          '{"should_conclude": false, "verdict": "positions divergent", "convergence_score": 0.3, "key_findings": [], "dissent": ["direction"], "action": "continue"}',
          // Round 2: bull position
          '{"stance": "Earnings momentum outweighs rate concerns", "evidence": ["Historical precedent"], "confidence": 0.75}',
          // Round 2: bear position
          '{"stance": "Rate hikes will suppress valuations", "evidence": ["Bond yields rising"], "confidence": 0.65}',
          // Round 2: judge decision (conclude)
          '{"should_conclude": true, "verdict": "Mixed outlook with rate risk", "convergence_score": 0.7, "key_findings": ["Both sides agree earnings are strong"], "dissent": ["Rate impact magnitude"], "action": "accept"}',
        ],
      },
    });

    const mod = new DebateModule({
      roles: [
        { id: "bull", persona: "opposing_researcher" },
        { id: "bear", persona: "opposing_researcher" },
      ],
      maxRounds: 3,
      termination: { type: "judge_decision" },
    });

    const output = await mod.process(
      buildInput({ query: "Will the stock market rise?" }),
      ctx,
    );

    expect(output.data.debateState).toBeDefined();
    expect(output.data.consensusReport).toBeDefined();
    expect(output.metrics?.debateRounds).toBeGreaterThanOrEqual(1);
  });

  it("should terminate at max rounds", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"stance": "Position A", "evidence": [], "confidence": 0.5}',
          '{"stance": "Position B", "evidence": [], "confidence": 0.5}',
          // Consensus report when max rounds reached
          '{"verdict": "No consensus", "convergence_score": 0.3, "key_findings": [], "dissent": ["everything"], "action": "escalate"}',
        ],
      },
    });

    const mod = new DebateModule({
      roles: [
        { id: "a", persona: "researcher" },
        { id: "b", persona: "researcher" },
      ],
      maxRounds: 1,
      termination: { type: "max_rounds" },
    });

    const output = await mod.process(
      buildInput({ query: "Test topic" }),
      ctx,
    );

    expect(output.data.debateState).toBeDefined();
    expect((output.data.debateState as any).currentRound).toBe(1);
    expect((output.data.debateState as any).concluded).toBe(true);
  });

  it("should handle LLM failures gracefully", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new DebateModule({
      roles: [
        { id: "a", persona: "researcher" },
        { id: "b", persona: "researcher" },
      ],
      maxRounds: 1,
    });

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    // Should still produce output with fallback positions
    expect(output.data.debateState).toBeDefined();
    const state = output.data.debateState as any;
    expect(state.positions.length).toBe(2);
    expect(state.positions[0].stance).toBe("Unable to generate position");
  });
});
