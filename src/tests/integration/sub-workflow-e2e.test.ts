import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import { ModuleRegistry } from "../../core/ModuleRegistry.js";
import type { BaseModule, ModuleInput, ModuleOutput, WorkflowConfig } from "../../core/types.js";
import { z } from "zod";

class TestMultiplierModule implements BaseModule {
  readonly name = "TestMultiplier";
  readonly version = "1.0.0";

  async process(input: ModuleInput, _ctx: unknown): Promise<ModuleOutput> {
    const value = (input.data.value as number) ?? 0;
    return { data: { value: value * 2 }, metrics: { doubled: 1 } };
  }

  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

describe("SubWorkflow E2E", () => {
  beforeEach(() => {
    ModuleRegistry.reset();
    ModuleRegistry.getInstance().register("TestMultiplier", TestMultiplierModule as any);
  });

  afterEach(() => {
    ModuleRegistry.reset();
  });

  test("parent → child → merged state", async () => {
    const childWorkflow: WorkflowConfig = {
      name: "child",
      version: "1.0",
      entry: "s1",
      stages: [{ id: "s1", module: "TestMultiplier", config: {} }],
    };

    const parentConfig = {
      name: "parent",
      version: "1.0",
      entry: "child",
      stages: [
        {
          id: "child",
          module: "SubWorkflow",
          config: { workflow: childWorkflow, inputMap: { value: "value" }, outputMap: { value: "result" } },
        },
      ],
    };

    const engine = new WorkflowEngine(parentConfig);
    await engine.initialize({});

    try {
      const state = await engine.run({ value: 21 });
      expect(state.data.result).toBe(42);
      expect(state.data.value).toBe(21); // original input preserved
    } finally {
      await engine.shutdown();
    }
  });

  test("sub-workflow nested depth guard prevents infinite recursion", async () => {
    const childWorkflow: WorkflowConfig = {
      name: "child-wf",
      version: "1.0",
      entry: "nested",
      stages: [
        {
          id: "nested",
          module: "SubWorkflow",
          config: {
            workflow: {
              name: "grandchild",
              version: "1.0",
              entry: "s1",
              stages: [{ id: "s1", module: "TestMultiplier", config: {} }],
            },
            inputMap: { value: "value" },
            outputMap: { value: "value" },
            maxDepth: 1, // inner sub-workflow also enforces depth limit
          },
        },
      ],
    };

    const parentConfig = {
      name: "parent-depth",
      version: "1.0",
      entry: "child",
      stages: [
        {
          id: "child",
          module: "SubWorkflow",
          config: {
            workflow: childWorkflow,
            inputMap: { value: "value" },
            outputMap: { value: "result" },
            maxDepth: 1,
          },
        },
      ],
    };

    const engine = new WorkflowEngine(parentConfig);
    await engine.initialize({});

    try {
      // Parent depth=0 → increments to 1, runs child
      // Child depth=1 → check 1 >= 1 → throws before running grandchild
      await engine.run({ value: 5 });
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.message).toContain("recursion depth exceeded");
    } finally {
      await engine.shutdown();
    }
  });
});
