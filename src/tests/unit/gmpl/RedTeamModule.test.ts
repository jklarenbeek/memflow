import { describe, it, expect } from "bun:test";
import { RedTeamModule } from "../../../gmpl/modules/RedTeamModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("RedTeamModule", () => {
  it("should run red/blue rounds and produce resilience report", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Round 1: attacker
          '{"attack": "The proposal ignores edge cases in distributed systems", "target_weakness": "scalability"}',
          // Round 1: defender
          '{"defense": "We have horizontal scaling built in", "mitigations": ["Auto-scaling", "Load balancing"], "confidence": 0.8}',
          // Round 1: judge
          '{"verdict": "Proposal is resilient", "resilience_score": 0.85, "vulnerabilities": [], "strengths": ["Good scaling"], "action": "accept"}',
        ],
      },
    });

    const mod = new RedTeamModule({
      redTeam: [{ id: "attacker_1", persona: "adversarial_analyst" }],
      blueTeam: [{ id: "defender_1", persona: "domain_expert" }],
      maxRounds: 3,
      resilienceThreshold: 0.7,
    });

    const output = await mod.process(
      buildInput({ query: "Deploy a microservices architecture for payments" }),
      ctx,
    );

    expect(output.data.redTeamState).toBeDefined();
    const state = output.data.redTeamState as any;
    expect(state.concluded).toBe(true);
    expect(state.resilienceReport.resilienceScore).toBeGreaterThanOrEqual(0.7);
    expect(state.attacks.length).toBe(1);
    expect(state.defenses.length).toBe(1);
    expect(output.data.finalAnswer).toBeDefined();
  });

  it("should continue through multiple rounds when resilience is low", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Round 1: attack
          '{"attack": "No disaster recovery plan", "target_weakness": "resilience"}',
          // Round 1: defense
          '{"defense": "We will add DR", "mitigations": ["Backup"], "confidence": 0.4}',
          // Round 1: judge (low resilience)
          '{"verdict": "Needs work", "resilience_score": 0.3, "vulnerabilities": ["No DR"], "strengths": [], "action": "strengthen"}',
          // Round 2: attack
          '{"attack": "Single point of failure in DB", "target_weakness": "availability"}',
          // Round 2: defense
          '{"defense": "Will add replication", "mitigations": ["DB replication"], "confidence": 0.6}',
          // Round 2: judge (passes threshold)
          '{"verdict": "Improved", "resilience_score": 0.75, "vulnerabilities": [], "strengths": ["Replication"], "action": "accept"}',
        ],
      },
    });

    const mod = new RedTeamModule({
      redTeam: [{ id: "a1", persona: "attacker" }],
      blueTeam: [{ id: "d1", persona: "defender" }],
      maxRounds: 3,
      resilienceThreshold: 0.7,
    });

    const output = await mod.process(
      buildInput({ query: "Database architecture proposal" }),
      ctx,
    );

    const state = output.data.redTeamState as any;
    expect(state.currentRound).toBe(2);
    expect(state.attacks.length).toBe(2);
  });

  it("should handle LLM failures gracefully", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new RedTeamModule({
      redTeam: [{ id: "a1", persona: "attacker" }],
      blueTeam: [{ id: "d1", persona: "defender" }],
      maxRounds: 1,
    });

    const output = await mod.process(
      buildInput({ query: "Test proposal" }),
      ctx,
    );

    expect(output.data.redTeamState).toBeDefined();
    const state = output.data.redTeamState as any;
    expect(state.concluded).toBe(true);
    expect(state.attacks[0].attack).toBe("Unable to generate attack");
  });

  it("should cycle through attack strategies", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"attack": "Attack 1", "target_weakness": "w1"}',
          '{"defense": "Defense 1", "mitigations": [], "confidence": 0.5}',
          '{"verdict": "Low", "resilience_score": 0.2, "vulnerabilities": ["w1"], "strengths": [], "action": "strengthen"}',
          '{"attack": "Attack 2", "target_weakness": "w2"}',
          '{"defense": "Defense 2", "mitigations": [], "confidence": 0.5}',
          '{"verdict": "OK", "resilience_score": 0.8, "vulnerabilities": [], "strengths": ["s1"], "action": "accept"}',
        ],
      },
    });

    const mod = new RedTeamModule({
      attackStrategies: ["strategy_a", "strategy_b"],
      redTeam: [{ id: "a1", persona: "attacker" }],
      blueTeam: [{ id: "d1", persona: "defender" }],
      maxRounds: 3,
      resilienceThreshold: 0.7,
    });

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    const state = output.data.redTeamState as any;
    // First round uses strategy_a, second uses strategy_b
    expect(state.attacks[0].strategy).toBe("strategy_a");
    expect(state.attacks[1].strategy).toBe("strategy_b");
  });
});
