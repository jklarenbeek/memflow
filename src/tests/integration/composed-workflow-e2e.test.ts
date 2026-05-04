/**
 * G9 — Composed Workflow E2E Tests
 *
 * Validates that PatternComposer can generate valid workflow configs
 * from multi-pattern compositions, and that reference composition
 * workflow JSON files are structurally correct.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { generateWorkflow } from "../../gmpl/PatternComposer.js";
import { PatternRegistry } from "../../gmpl/PatternRegistry.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { WorkflowConfig } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadReferenceWorkflow(filename: string): Record<string, unknown> {
  const path = resolve(
    process.cwd(),
    "src/workflows/examples",
    filename,
  );
  if (!existsSync(path)) {
    throw new Error(`Reference workflow not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ---------------------------------------------------------------------------
// PatternComposer: Single-pattern composition
// ---------------------------------------------------------------------------

describe("PatternComposer: single-pattern composition", () => {
  beforeEach(() => {
    PatternRegistry.reset();
  });

  test("generates valid workflow for structured_debate", () => {
    const workflow = generateWorkflow({
      name: "test-debate",
      stages: [
        {
          id: "debate",
          pattern: "structured_debate",
          config: {
            roles: [
              { id: "bull", persona: "Bullish researcher" },
              { id: "bear", persona: "Bearish researcher" },
            ],
            maxRounds: 2,
          },
        },
      ],
    });

    expect(workflow.name).toBe("test-debate");
    expect(workflow.entry).toBe("debate");
    expect(workflow.stages).toHaveLength(1);
    expect(workflow.stages[0].module).toBe("SubWorkflow");
    expect(workflow.stages[0].config._patternId).toBe("structured_debate");
    expect(workflow.stages[0].workflowRef).toContain("structured-debate");
  });

  test("generates valid workflow for parallel_analysis", () => {
    const workflow = generateWorkflow({
      name: "test-analysis",
      stages: [
        {
          id: "analyze",
          pattern: "parallel_analysis",
          config: {
            analysts: [
              { id: "a1", role: "domain_analyst" },
              { id: "a2", role: "domain_analyst" },
            ],
          },
        },
      ],
    });

    expect(workflow.entry).toBe("analyze");
    expect(workflow.stages[0].workflowRef).toContain("parallel-analysis");
  });

  test("appends OutcomeMemory when two-phase enabled", () => {
    const workflow = generateWorkflow({
      name: "test-with-memory",
      stages: [
        { id: "debate", pattern: "structured_debate", config: { roles: [{ id: "r1", persona: "test" }] } },
      ],
      memory: { twoPhaseEnabled: true, pendingTTL: "14d" },
    });

    expect(workflow.stages).toHaveLength(2);
    expect(workflow.stages[1].id).toBe("_outcome_memory");
    expect(workflow.stages[1].module).toBe("OutcomeMemory");
    expect(workflow.stages[0].next).toBe("_outcome_memory");
    expect(workflow.stages[1].next).toBeNull();
  });

  test("sets domain tenantId in globalConfig", () => {
    const workflow = generateWorkflow({
      name: "test-domain",
      domain: "trading",
      stages: [{ id: "s1", pattern: "structured_debate", config: { roles: [{ id: "r1", persona: "test" }] } }],
    });

    expect(workflow.globalConfig?.tenantId).toBe("trading");
  });

  test("throws PatternNotFoundError for unknown pattern", () => {
    expect(() =>
      generateWorkflow({
        name: "test-bad",
        stages: [{ id: "s1", pattern: "nonexistent_pattern" }],
      }),
    ).toThrow(/not found/i);
  });

  test("throws CompositionError for empty stages", () => {
    expect(() =>
      generateWorkflow({ name: "test-empty", stages: [] }),
    ).toThrow(/at least one stage/i);
  });
});

// ---------------------------------------------------------------------------
// PatternComposer: Multi-pattern composition
// ---------------------------------------------------------------------------

describe("PatternComposer: multi-pattern composition", () => {
  beforeEach(() => {
    PatternRegistry.reset();
  });

  test("chains two patterns sequentially", () => {
    const workflow = generateWorkflow({
      name: "two-pattern",
      stages: [
        { id: "analyze", pattern: "parallel_analysis", config: { analysts: [{ id: "a1" }] } },
        { id: "debate", pattern: "structured_debate", config: { roles: [{ id: "r1", persona: "test" }] } },
      ],
    });

    expect(workflow.stages).toHaveLength(2);
    expect(workflow.stages[0].id).toBe("analyze");
    expect(workflow.stages[0].next).toBe("debate");
    expect(workflow.stages[1].id).toBe("debate");
    expect(workflow.stages[1].next).toBeNull();
  });

  test("chains three patterns with outcome memory", () => {
    const workflow = generateWorkflow({
      name: "three-pattern-memory",
      stages: [
        { id: "dispatch", pattern: "parallel_analysis", config: { analysts: [{ id: "a1" }] } },
        { id: "debate", pattern: "structured_debate", config: { roles: [{ id: "r1", persona: "test" }] } },
        { id: "review", pattern: "peer_review", config: { reviewers: [{ id: "rev1", persona: "critic" }] } },
      ],
      memory: { twoPhaseEnabled: true },
    });

    expect(workflow.stages).toHaveLength(4); // 3 patterns + outcome memory
    expect(workflow.stages[0].next).toBe("debate");
    expect(workflow.stages[1].next).toBe("review");
    expect(workflow.stages[2].next).toBe("_outcome_memory");
    expect(workflow.stages[3].next).toBeNull();
    expect(workflow.stages[3].module).toBe("OutcomeMemory");
  });

  test("workflow description includes pattern chain", () => {
    const workflow = generateWorkflow({
      name: "described",
      stages: [
        { id: "s1", pattern: "parallel_analysis", config: { analysts: [{ id: "a1" }] } },
        { id: "s2", pattern: "red_team", config: { redTeam: [{ id: "rt1", persona: "attacker" }], blueTeam: [{ id: "bt1", persona: "defender" }] } },
      ],
    });

    expect(workflow.description).toContain("parallel_analysis");
    expect(workflow.description).toContain("red_team");
  });
});

// ---------------------------------------------------------------------------
// Reference workflow JSON validation
// ---------------------------------------------------------------------------

describe("Reference composition workflows", () => {
  test("trading-analysis.json is structurally valid", () => {
    const wf = loadReferenceWorkflow("trading-analysis.json") as unknown as WorkflowConfig;
    expect(wf.name).toBe("trading-analysis-pipeline");
    expect(wf.entry).toBe("analyst_dispatch");
    expect(wf.stages.length).toBeGreaterThanOrEqual(3);

    // Verify stage IDs are unique
    const stageIds = wf.stages.map((s) => s.id);
    expect(new Set(stageIds).size).toBe(stageIds.length);

    // Verify known module names
    const moduleNames = wf.stages.map((s) => s.module);
    expect(moduleNames).toContain("ParallelDispatcher");
    expect(moduleNames).toContain("DebateModule");
    expect(moduleNames).toContain("OutcomeMemory");

    // Verify entry stage exists
    expect(stageIds).toContain(wf.entry);
  });

  test("healthcare-assistant.json is structurally valid", () => {
    const wf = loadReferenceWorkflow("healthcare-assistant.json") as unknown as WorkflowConfig;
    expect(wf.name).toBe("healthcare-clinical-assistant");
    expect(wf.entry).toBe("clarify_intent");
    expect(wf.stages.length).toBeGreaterThanOrEqual(4);

    const stageIds = wf.stages.map((s) => s.id);
    expect(new Set(stageIds).size).toBe(stageIds.length);
    expect(stageIds).toContain(wf.entry);

    // Healthcare workflow uses DualSourceFusion with authoritySafelist
    const fusionStage = wf.stages.find((s) => s.module === "DualSourceFusion");
    expect(fusionStage).toBeDefined();
    expect((fusionStage!.config as any).authoritySafelist.length).toBeGreaterThan(0);
  });

  test("autonomous-research.json is structurally valid", () => {
    const wf = loadReferenceWorkflow("autonomous-research.json") as unknown as WorkflowConfig;
    expect(wf.name).toBe("autonomous-research-pipeline");
    expect(wf.entry).toBe("research_dispatch");
    expect(wf.stages.length).toBeGreaterThanOrEqual(3);

    const stageIds = wf.stages.map((s) => s.id);
    expect(new Set(stageIds).size).toBe(stageIds.length);
    expect(stageIds).toContain(wf.entry);

    // Research workflow includes Delphi + RedTeam
    const modules = wf.stages.map((s) => s.module);
    expect(modules).toContain("DelphiPanelModule");
    expect(modules).toContain("RedTeamModule");
  });

  test("all reference workflows have valid stage wiring (no dangling next)", () => {
    const files = ["trading-analysis.json", "healthcare-assistant.json", "autonomous-research.json"];

    for (const file of files) {
      const wf = loadReferenceWorkflow(file) as unknown as WorkflowConfig;
      const stageIds = new Set(wf.stages.map((s) => s.id));

      for (const stage of wf.stages) {
        if (stage.next !== null && stage.next !== undefined) {
          const nextId = typeof stage.next === "string" ? stage.next : null;
          if (nextId) {
            expect(stageIds.has(nextId)).toBe(true);
          }
        }
      }
    }
  });
});
