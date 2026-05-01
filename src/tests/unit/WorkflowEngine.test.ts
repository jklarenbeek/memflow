import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import { ModuleRegistry } from "../../core/ModuleRegistry.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";
import type { BaseModule, ModuleInput, ModuleOutput, WorkflowConfig } from "../../core/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Test module — a simple passthrough
// ---------------------------------------------------------------------------

class TestPassthroughModule implements BaseModule {
  readonly name = "TestPassthrough";
  readonly version = "1.0.0";
  processCount = 0;

  async process(input: ModuleInput, _ctx: unknown): Promise<ModuleOutput> {
    this.processCount++;
    return {
      data: { testOutput: `processed-${this.processCount}` },
      metrics: { calls: this.processCount },
    };
  }
  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

class TestFailModule implements BaseModule {
  readonly name = "TestFail";
  readonly version = "1.0.0";
  callCount = 0;

  async process(): Promise<ModuleOutput> {
    this.callCount++;
    throw new Error(`Intentional failure #${this.callCount}`);
  }
  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowEngine", () => {
  beforeEach(() => {
    ModuleRegistry.reset();
    const registry = ModuleRegistry.getInstance();
    registry.register("TestPassthrough", TestPassthroughModule as any);
    registry.register("TestFail", TestFailModule as any);
  });

  afterEach(() => {
    ModuleRegistry.reset();
  });

  it("should validate config on construction", () => {
    expect(() => new WorkflowEngine({} as any)).toThrow();
  });

  it("should reject missing entry point", () => {
    expect(
      () =>
        new WorkflowEngine({
          name: "test",
          version: "1.0",
          entry: "nonexistent",
          stages: [{ id: "s1", module: "TestPassthrough", config: {} }],
        }),
    ).toThrow(/nonexistent/);
  });

  it("should reject unknown next stage references", () => {
    expect(
      () =>
        new WorkflowEngine({
          name: "test",
          version: "1.0",
          entry: "s1",
          stages: [
            { id: "s1", module: "TestPassthrough", config: {}, next: "doesnt_exist" },
          ],
        }),
    ).toThrow(/doesnt_exist/);
  });

  it("should require initialization before run", async () => {
    const engine = new WorkflowEngine({
      name: "test",
      version: "1.0",
      entry: "s1",
      stages: [{ id: "s1", module: "TestPassthrough", config: {} }],
    });

    expect(engine.run()).rejects.toThrow(/not initialized/i);
  });

  it("should execute a single-stage workflow", async () => {
    const engine = new WorkflowEngine({
      name: "test-single",
      version: "1.0",
      entry: "s1",
      stages: [{ id: "s1", module: "TestPassthrough", config: {} }],
    });

    await engine.initialize({});

    try {
      const state = await engine.run({ query: "Test" });
      expect(state.history.length).toBe(1);
      expect(state.history[0].stage).toBe("s1");
      expect(state.data.testOutput).toBe("processed-1");
      expect(state.metadata.totalDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await engine.shutdown();
    }
  });

  it("should execute a multi-stage sequential workflow", async () => {
    const engine = new WorkflowEngine({
      name: "test-multi",
      version: "1.0",
      entry: "s1",
      stages: [
        { id: "s1", module: "TestPassthrough", config: {}, next: "s2" },
        { id: "s2", module: "TestPassthrough", config: {} },
      ],
    });

    await engine.initialize({});

    try {
      const state = await engine.run();
      expect(state.history.length).toBe(2);
      expect(state.history[0].stage).toBe("s1");
      expect(state.history[1].stage).toBe("s2");
    } finally {
      await engine.shutdown();
    }
  });

  it("should handle stage failures with retry", async () => {
    const engine = new WorkflowEngine({
      name: "test-retry",
      version: "1.0",
      entry: "s1",
      stages: [
        { id: "s1", module: "TestFail", config: {}, retry: 2, retryDelayMs: 10 },
      ],
    });

    await engine.initialize({});

    try {
      await engine.run();
      // Should never reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe("STAGE_EXECUTION_FAILED");
      expect(err.stageId).toBe("s1");
      expect(err.attempt).toBe(3); // 1 initial + 2 retries
    } finally {
      await engine.shutdown();
    }
  });

  it("should record errors in state", async () => {
    const engine = new WorkflowEngine({
      name: "test-errors",
      version: "1.0",
      entry: "s1",
      stages: [
        { id: "s1", module: "TestFail", config: {}, retry: 1, retryDelayMs: 10 },
      ],
    });

    await engine.initialize({});

    try {
      await engine.run();
    } catch {
      const state = engine.getState();
      expect(state.errors.length).toBe(2); // initial + 1 retry
      expect(state.errors[0].stage).toBe("s1");
    } finally {
      await engine.shutdown();
    }
  });

  it("should export state as JSON", async () => {
    const engine = new WorkflowEngine({
      name: "test-export",
      version: "1.0",
      entry: "s1",
      stages: [{ id: "s1", module: "TestPassthrough", config: {} }],
    });

    await engine.initialize({});

    try {
      await engine.run({ query: "export test" });
      const json = engine.exportState();
      const parsed = JSON.parse(json);
      expect(parsed.metadata.workflowName).toBe("test-export");
      expect(parsed.data.query).toBe("export test");
    } finally {
      await engine.shutdown();
    }
  });
});
