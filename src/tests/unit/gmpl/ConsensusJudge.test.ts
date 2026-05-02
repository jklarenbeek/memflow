import { describe, it, expect } from "bun:test";
import { ConsensusJudgeModule } from "../../../gmpl/modules/ConsensusJudgeModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";
import type { DebateState } from "../../../gmpl/types.js";

describe("ConsensusJudgeModule", () => {
  const makeDebateState = (convergence: number): DebateState => ({
    positions: [
      { roleId: "bull", stance: "Markets will rise", evidence: ["earnings"], confidence: convergence, round: 1 },
      { roleId: "bear", stance: "Markets will fall", evidence: ["rates"], confidence: convergence * 0.9, round: 1 },
    ],
    currentRound: 1,
    concluded: false,
  });

  it("should produce a consensus report from debate state", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"verdict": "Mixed outlook", "convergence_score": 0.6, "key_findings": ["earnings strong"], "dissent": ["rate impact"], "action": "continue"}',
        ],
      },
    });

    const mod = new ConsensusJudgeModule({});
    const output = await mod.process(
      buildInput({ debateState: makeDebateState(0.7) }),
      ctx,
    );

    expect(output.data.consensusReport).toBeDefined();
    expect(output.metrics?.judged).toBe(true);
    const report = output.data.consensusReport as any;
    expect(report.action).toBe("continue");
  });

  it("should fallback when LLM fails", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new ConsensusJudgeModule({ convergenceThreshold: 0.5 });
    const output = await mod.process(
      buildInput({ debateState: makeDebateState(0.8) }),
      ctx,
    );

    expect(output.data.consensusReport).toBeDefined();
    const report = output.data.consensusReport as any;
    // High confidence should trigger accept even in fallback
    expect(report.convergenceScore).toBeGreaterThan(0.5);
  });

  it("should return empty result when no debate state", async () => {
    const { ctx } = createMockContext();
    const mod = new ConsensusJudgeModule({});
    const output = await mod.process(buildInput({}), ctx);
    expect(output.metrics?.judged).toBe(false);
  });
});
