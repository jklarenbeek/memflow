import { describe, it, expect, beforeEach } from "bun:test";
import { generateWorkflow } from "../../../gmpl/PatternComposer.js";
import { PatternRegistry } from "../../../gmpl/PatternRegistry.js";

describe("PatternComposer", () => {
  beforeEach(() => {
    PatternRegistry.reset();
  });

  it("should generate a valid WorkflowConfig from a single-pattern composition", () => {
    const workflow = generateWorkflow({
      name: "single-debate",
      stages: [{ id: "debate", pattern: "structured_debate" }],
    });

    expect(workflow.name).toBe("single-debate");
    expect(workflow.version).toBe("1.0");
    expect(workflow.entry).toBe("debate");
    expect(workflow.stages.length).toBe(1);
    expect(workflow.stages[0].module).toBe("SubWorkflow");
    expect(workflow.stages[0].workflowRef).toContain("structured-debate.json");
  });

  it("should generate a multi-pattern sequential workflow", () => {
    const workflow = generateWorkflow({
      name: "research-pipeline",
      stages: [
        { id: "analyze", pattern: "parallel_analysis" },
        { id: "debate", pattern: "structured_debate" },
      ],
    });

    expect(workflow.stages.length).toBe(2);
    expect(workflow.entry).toBe("analyze");
    // First stage should point to second
    expect(workflow.stages[0].next).toBe("debate");
    // Last stage should have null next
    expect(workflow.stages[1].next).toBeNull();
  });

  it("should append OutcomeMemory stage when twoPhaseEnabled", () => {
    const workflow = generateWorkflow({
      name: "with-memory",
      stages: [{ id: "debate", pattern: "structured_debate" }],
      memory: {
        twoPhaseEnabled: true,
        pendingTTL: "14d",
      },
    });

    expect(workflow.stages.length).toBe(2);
    expect(workflow.stages[0].next).toBe("_outcome_memory");
    expect(workflow.stages[1].id).toBe("_outcome_memory");
    expect(workflow.stages[1].module).toBe("OutcomeMemory");
    expect((workflow.stages[1].config as any).twoPhaseEnabled).toBe(true);
  });

  it("should support direct module references", () => {
    const workflow = generateWorkflow({
      name: "direct-module",
      stages: [
        { id: "clarify", module: "MultiTurnClarifier", config: { maxTurns: 3 } },
        { id: "debate", pattern: "structured_debate" },
      ],
    });

    expect(workflow.stages[0].module).toBe("MultiTurnClarifier");
    expect((workflow.stages[0].config as any).maxTurns).toBe(3);
    expect(workflow.stages[1].module).toBe("SubWorkflow");
  });

  it("should throw on unknown pattern ID", () => {
    expect(() =>
      generateWorkflow({
        name: "bad",
        stages: [{ id: "x", pattern: "nonexistent_pattern" }],
      }),
    ).toThrow(/not found in PatternRegistry/);
  });

  it("should throw on empty stages", () => {
    expect(() =>
      generateWorkflow({
        name: "empty",
        stages: [],
      }),
    ).toThrow(/at least one stage/);
  });

  it("should throw when stage has neither pattern nor module", () => {
    expect(() =>
      generateWorkflow({
        name: "broken",
        stages: [{ id: "orphan" }],
      }),
    ).toThrow(/must specify either/);
  });

  it("should set domain as tenantId in globalConfig", () => {
    const workflow = generateWorkflow({
      name: "trading",
      domain: "trading",
      stages: [{ id: "analyze", pattern: "parallel_analysis" }],
    });

    expect(workflow.globalConfig?.tenantId).toBe("trading");
  });

  it("should include all 6 patterns in the registry", () => {
    const patterns = PatternRegistry.getInstance().list();
    expect(patterns).toContain("structured_debate");
    expect(patterns).toContain("clarification_pipeline");
    expect(patterns).toContain("parallel_analysis");
    expect(patterns).toContain("peer_review");
    expect(patterns).toContain("red_team");
    expect(patterns).toContain("delphi_panel");
    expect(patterns.length).toBe(6);
  });
});
