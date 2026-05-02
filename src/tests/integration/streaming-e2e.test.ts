import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import { ModuleRegistry } from "../../core/ModuleRegistry.js";
import type { BaseModule, ModuleInput, ModuleOutput, StreamEvent, StreamableModule } from "../../core/types.js";
import { z } from "zod";

class TestStreamableModule implements StreamableModule {
  readonly name = "TestStreamable";
  readonly version = "1.0.0";

  async *processStream(_input: ModuleInput, _ctx: unknown): AsyncGenerator<StreamEvent, ModuleOutput, undefined> {
    yield { type: "stage:progress", stageId: "s1", module: "TestStreamable", token: "Hello", tokenIndex: 0, timestamp: new Date().toISOString() };
    yield { type: "stage:progress", stageId: "s1", module: "TestStreamable", token: " world", tokenIndex: 1, timestamp: new Date().toISOString() };
    return { data: { finalAnswer: "Hello world" }, metrics: { tokens: 2 } };
  }

  async process(_input: ModuleInput, _ctx: unknown): Promise<ModuleOutput> {
    return { data: { finalAnswer: "Hello world" }, metrics: { tokens: 2 } };
  }

  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

describe("SSE Streaming E2E", () => {
  beforeEach(() => {
    ModuleRegistry.reset();
    ModuleRegistry.getInstance().register("TestStreamable", TestStreamableModule as any);
  });

  afterEach(() => {
    ModuleRegistry.reset();
  });

  test("runStream yields correct event sequence", async () => {
    const config = {
      name: "streaming-test",
      version: "1.0",
      entry: "s1",
      stages: [{ id: "s1", module: "TestStreamable", config: {} }],
    };

    const engine = new WorkflowEngine(config);
    await engine.initialize({});

    try {
      const events: StreamEvent[] = [];
      for await (const event of engine.runStream({ query: "test" })) {
        events.push(event);
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("workflow:start");
      expect(types).toContain("stage:start");
      expect(types).toContain("stage:progress");
      expect(types).toContain("stage:complete");
      expect(types).toContain("workflow:complete");

      // Verify ordering: workflow:start before stage events before workflow:complete
      const wfStartIdx = types.indexOf("workflow:start");
      const stageStartIdx = types.indexOf("stage:start");
      const stageCompleteIdx = types.indexOf("stage:complete");
      const wfCompleteIdx = types.indexOf("workflow:complete");

      expect(wfStartIdx).toBeLessThan(stageStartIdx);
      expect(stageStartIdx).toBeLessThan(stageCompleteIdx);
      expect(stageCompleteIdx).toBeLessThan(wfCompleteIdx);

      // Verify progress tokens
      const progressEvents = events.filter((e) => e.type === "stage:progress");
      expect(progressEvents.length).toBe(2);
      expect((progressEvents[0] as Extract<StreamEvent, { type: "stage:progress" }>).token).toBe("Hello");
      expect((progressEvents[1] as Extract<StreamEvent, { type: "stage:progress" }>).token).toBe(" world");
    } finally {
      await engine.shutdown();
    }
  });

  test("engine.events emitter receives all events", async () => {
    const config = {
      name: "streaming-test",
      version: "1.0",
      entry: "s1",
      stages: [{ id: "s1", module: "TestStreamable", config: {} }],
    };

    const engine = new WorkflowEngine(config);
    await engine.initialize({});

    try {
      const events: StreamEvent[] = [];
      engine.events.on("*", (e) => events.push(e));

      for await (const _event of engine.runStream({ query: "test" })) {
        // consume
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("workflow:start");
      expect(types).toContain("stage:start");
      expect(types).toContain("stage:progress");
      expect(types).toContain("stage:complete");
      expect(types).toContain("workflow:complete");
    } finally {
      await engine.shutdown();
    }
  });
});
