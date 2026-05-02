import { describe, it, expect } from "bun:test";
import { PeerReviewModule } from "../../../gmpl/modules/PeerReviewModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("PeerReviewModule", () => {
  it("should run a review cycle and accept the draft", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Cycle 1: reviewer 1 accepts
          '{"assessment": "accept", "feedback": "Well written", "issues": [], "strengths": ["Clear structure"]}',
          // Cycle 1: reviewer 2 accepts
          '{"assessment": "accept", "feedback": "Good quality", "issues": [], "strengths": ["Thorough analysis"]}',
        ],
      },
    });

    const mod = new PeerReviewModule({
      reviewers: [
        { id: "r1", persona: "critic" },
        { id: "r2", persona: "critic" },
      ],
      maxCycles: 3,
      acceptanceThreshold: 0.5,
    });

    const output = await mod.process(
      buildInput({ query: "This is a draft document for review." }),
      ctx,
    );

    expect(output.data.peerReviewState).toBeDefined();
    const state = output.data.peerReviewState as any;
    expect(state.accepted).toBe(true);
    expect(state.currentCycle).toBe(1);
    expect(output.data.finalAnswer).toBeDefined();
  });

  it("should revise draft when reviewers request changes", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Cycle 1: reviewer 1 requests revision
          '{"assessment": "major_revision", "feedback": "Needs more detail", "issues": ["Lacks evidence"], "strengths": ["Good idea"]}',
          // Cycle 1: reviewer 2 requests revision
          '{"assessment": "minor_revision", "feedback": "Almost there", "issues": ["Typos"], "strengths": ["Clear"]}',
          // Revision LLM call
          "Here is the revised draft with more detail and fixed typos.",
          // Cycle 2: reviewer 1 accepts
          '{"assessment": "accept", "feedback": "Much better", "issues": [], "strengths": ["Improved"]}',
          // Cycle 2: reviewer 2 accepts
          '{"assessment": "accept", "feedback": "Good", "issues": [], "strengths": ["Clean"]}',
        ],
      },
    });

    const mod = new PeerReviewModule({
      reviewers: [
        { id: "r1", persona: "critic" },
        { id: "r2", persona: "critic" },
      ],
      maxCycles: 3,
      acceptanceThreshold: 0.5,
    });

    const output = await mod.process(
      buildInput({ query: "Initial draft content." }),
      ctx,
    );

    const state = output.data.peerReviewState as any;
    expect(state.accepted).toBe(true);
    expect(state.currentCycle).toBe(2);
    expect(state.cycles.length).toBe(2);
  });

  it("should terminate at max cycles without acceptance", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"assessment": "major_revision", "feedback": "Not good enough", "issues": ["Many issues"], "strengths": []}',
          "Revised draft attempt",
        ],
      },
    });

    const mod = new PeerReviewModule({
      reviewers: [{ id: "r1", persona: "critic" }],
      maxCycles: 1,
      acceptanceThreshold: 1.0,
    });

    const output = await mod.process(
      buildInput({ query: "Weak draft." }),
      ctx,
    );

    const state = output.data.peerReviewState as any;
    expect(state.accepted).toBe(false);
    expect(state.currentCycle).toBe(1);
  });

  it("should handle LLM failures gracefully", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new PeerReviewModule({
      reviewers: [
        { id: "r1", persona: "critic" },
        { id: "r2", persona: "critic" },
      ],
      maxCycles: 1,
    });

    const output = await mod.process(
      buildInput({ query: "Test draft" }),
      ctx,
    );

    expect(output.data.peerReviewState).toBeDefined();
    const state = output.data.peerReviewState as any;
    expect(state.cycles[0].feedback.length).toBe(2);
    expect(state.cycles[0].feedback[0].assessment).toBe("major_revision");
  });
});
