import { describe, it, expect } from "bun:test";
import { HERAOrchestratorModule } from "../../modules/agents/HERAOrchestratorModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";

describe("HERAOrchestratorModule", () => {
  it("should generate a plan and execute agents", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          // Plan generation
          '{"agents": ["retriever", "reasoner"], "order": "sequential", "tokenBudget": 4000}',
          // Retriever agent response
          "Found relevant evidence about S2 chunking methods.",
          // Reasoner agent response
          "S2 chunking combines spatial and semantic analysis for better document segmentation.",
          // Reflection (no prior trajectories so skipped)
          // Synthesis
          "S2 chunking is a hybrid framework that uses both spatial layout and semantic similarity. [1]",
        ],
      },
    });

    const mod = new HERAOrchestratorModule({ enableEvolution: false });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({ query: "What is S2 chunking?" }),
      ctx,
    );

    expect(output.data.agentResult).toBeDefined();
    expect(output.data.finalAnswer).toBeDefined();
    expect(output.data.agentResult!.trajectory.steps.length).toBeGreaterThan(0);
    expect(output.metrics?.agents).toBeGreaterThan(0);
    expect(output.metrics?.trajectorySteps).toBeGreaterThan(0);
  });

  it("should fall back to default plan on LLM failure", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          "INVALID JSON", // Plan fails → fallback
          "Retriever output",
          "Reasoner output",
          "Synthesizer output",
          "Final synthesis",
        ],
      },
    });

    const mod = new HERAOrchestratorModule({ enableEvolution: false });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({ query: "Test query" }),
      ctx,
    );

    expect(output.data.agentResult).toBeDefined();
    expect(output.data.agentResult!.trajectory.plan.agents).toContain("retriever");
  });

  it("should produce metrics", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: ['{"agents": ["reasoner"], "order": "sequential"}', "Answer", "Final"],
      },
    });

    const mod = new HERAOrchestratorModule({ enableEvolution: false });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({ query: "Test" }),
      ctx,
    );

    expect(output.metrics).toHaveProperty("agents");
    expect(output.metrics).toHaveProperty("experienceSize");
    expect(output.metrics).toHaveProperty("trajectorySteps");
  });
});
