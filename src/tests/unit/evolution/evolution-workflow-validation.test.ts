/**
 * Evolution Layer — Workflow Structural Validation Tests (§9)
 *
 * Validates that all evolution-related workflow JSON files:
 *  1. Parse into valid WorkflowConfig objects
 *  2. Reference modules that exist in BUILTIN_MODULES
 *  3. Have all `next` references pointing to valid stage IDs
 *  4. Have no orphan stages (unreachable from entry)
 *  5. Have valid entry points
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Read the BUILTIN_MODULES keys from ModuleRegistry source
// ---------------------------------------------------------------------------

function getBuiltinModuleNames(): Set<string> {
  const registryPath = resolve(import.meta.dir, "../../../core/ModuleRegistry.ts");
  const source = readFileSync(registryPath, "utf-8");

  // Extract module names from the BUILTIN_MODULES map keys (format: `  ModuleName: () =>`)
  const moduleNames = new Set<string>();
  const regex = /^\s+(\w+):\s*\(\)\s*=>/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    moduleNames.add(match[1]);
  }
  return moduleNames;
}

// ---------------------------------------------------------------------------
// Workflow loading
// ---------------------------------------------------------------------------

interface WorkflowStage {
  id: string;
  module: string;
  next?: string | string[] | Record<string, string> | null;
  dependsOn?: string[];
}

interface WorkflowJSON {
  name: string;
  version: string;
  entry: string;
  stages: WorkflowStage[];
}

function loadWorkflow(filePath: string): WorkflowJSON {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as WorkflowJSON;
}

function getStageIds(wf: WorkflowJSON): Set<string> {
  return new Set(wf.stages.map((s) => s.id));
}

function getNextRefs(stage: WorkflowStage): string[] {
  if (stage.next === null || stage.next === undefined) return [];
  if (typeof stage.next === "string") return [stage.next];
  if (Array.isArray(stage.next)) return stage.next;
  // Conditional routing: { "condition": "stageId" }
  return Object.values(stage.next);
}

function getReachableStages(wf: WorkflowJSON): Set<string> {
  const reachable = new Set<string>();
  const stageMap = new Map(wf.stages.map((s) => [s.id, s]));
  const queue = [wf.entry];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);

    const stage = stageMap.get(id);
    if (stage) {
      for (const ref of getNextRefs(stage)) {
        if (!reachable.has(ref)) queue.push(ref);
      }
    }
  }

  return reachable;
}

// ---------------------------------------------------------------------------
// Collect all evolution-related workflow files
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = resolve(import.meta.dir, "../../../workflows");
const SUB_DIR = join(WORKFLOWS_DIR, "sub");
const EXAMPLES_DIR = join(WORKFLOWS_DIR, "examples");

const EVOLUTION_SUB_WORKFLOWS = [
  "trace2skill-pipeline.json",
  "slm-dataset-export.json",
  "harness-evolution.json",
  "intent-compiler.json",
];

const EVOLUTION_EXAMPLE_WORKFLOWS = [
  "self-improving-research.json",
  "skill-distillation-batch.json",
  "trading-harness-evolution.json",
];

const builtinModules = getBuiltinModuleNames();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Evolution Workflow Validation (§9)", () => {
  // Sub-workflows
  for (const filename of EVOLUTION_SUB_WORKFLOWS) {
    const filePath = join(SUB_DIR, filename);

    describe(`sub/${filename}`, () => {
      test("file exists", () => {
        expect(existsSync(filePath)).toBe(true);
      });

      test("parses as valid JSON with required fields", () => {
        const wf = loadWorkflow(filePath);
        expect(wf.name).toBeDefined();
        expect(wf.version).toBeDefined();
        expect(wf.entry).toBeDefined();
        expect(Array.isArray(wf.stages)).toBe(true);
        expect(wf.stages.length).toBeGreaterThan(0);
      });

      test("entry stage exists in stages array", () => {
        const wf = loadWorkflow(filePath);
        const ids = getStageIds(wf);
        expect(ids.has(wf.entry)).toBe(true);
      });

      test("all module references exist in BUILTIN_MODULES", () => {
        const wf = loadWorkflow(filePath);
        for (const stage of wf.stages) {
          expect(builtinModules.has(stage.module)).toBe(true);
        }
      });

      test("all next references point to valid stage IDs", () => {
        const wf = loadWorkflow(filePath);
        const ids = getStageIds(wf);
        for (const stage of wf.stages) {
          for (const ref of getNextRefs(stage)) {
            expect(ids.has(ref)).toBe(true);
          }
        }
      });

      test("no orphan stages (all reachable from entry)", () => {
        const wf = loadWorkflow(filePath);
        const reachable = getReachableStages(wf);
        const ids = getStageIds(wf);
        for (const id of ids) {
          expect(reachable.has(id)).toBe(true);
        }
      });
    });
  }

  // Example workflows
  for (const filename of EVOLUTION_EXAMPLE_WORKFLOWS) {
    const filePath = join(EXAMPLES_DIR, filename);

    describe(`examples/${filename}`, () => {
      test("file exists", () => {
        expect(existsSync(filePath)).toBe(true);
      });

      test("parses as valid JSON with required fields", () => {
        const wf = loadWorkflow(filePath);
        expect(wf.name).toBeDefined();
        expect(wf.version).toBeDefined();
        expect(wf.entry).toBeDefined();
        expect(Array.isArray(wf.stages)).toBe(true);
        expect(wf.stages.length).toBeGreaterThan(0);
      });

      test("entry stage exists in stages array", () => {
        const wf = loadWorkflow(filePath);
        const ids = getStageIds(wf);
        expect(ids.has(wf.entry)).toBe(true);
      });

      test("all module references exist in BUILTIN_MODULES", () => {
        const wf = loadWorkflow(filePath);
        for (const stage of wf.stages) {
          // SubWorkflow is always valid
          if (stage.module === "SubWorkflow") continue;
          expect(builtinModules.has(stage.module)).toBe(true);
        }
      });

      test("all next references point to valid stage IDs", () => {
        const wf = loadWorkflow(filePath);
        const ids = getStageIds(wf);
        for (const stage of wf.stages) {
          for (const ref of getNextRefs(stage)) {
            expect(ids.has(ref)).toBe(true);
          }
        }
      });

      test("no orphan stages (all reachable from entry)", () => {
        const wf = loadWorkflow(filePath);
        const reachable = getReachableStages(wf);
        const ids = getStageIds(wf);
        for (const id of ids) {
          expect(reachable.has(id)).toBe(true);
        }
      });
    });
  }

  // Meta-test: verify our module name extractor found a reasonable count
  test("BUILTIN_MODULES contains at least 70 modules", () => {
    expect(builtinModules.size).toBeGreaterThanOrEqual(70);
  });
});
