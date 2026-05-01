/**
 * Integration test — full pipeline execution with mocked providers
 *
 * This test wires up a multi-stage workflow (query → chunk → memory → retrieval)
 * using test modules to verify the engine correctly chains stages, passes state,
 * and produces a coherent final output.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import { ModuleRegistry } from "../../core/ModuleRegistry.js";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import { Document } from "@langchain/core/documents";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Lightweight test modules that simulate real behaviour
// ---------------------------------------------------------------------------

class TestChunkerModule implements BaseModule {
  readonly name = "TestChunker";
  readonly version = "1.0.0";

  async process(input: ModuleInput): Promise<ModuleOutput> {
    const text = (input.data.query as string) ?? "default text";
    return {
      data: {
        chunks: [
          new Document({ pageContent: `Chunk 1: ${text}`, metadata: { source: "test" } }),
          new Document({ pageContent: `Chunk 2: ${text} extended`, metadata: { source: "test" } }),
        ],
      },
      metrics: { chunkCount: 2 },
    };
  }
  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

class TestMemoryModule implements BaseModule {
  readonly name = "TestMemory";
  readonly version = "1.0.0";

  async process(input: ModuleInput): Promise<ModuleOutput> {
    const chunks = (input.data.chunks as Document[]) ?? [];
    return {
      data: {
        memoryUnits: chunks.map((c, i) => ({
          id: `mem-${i}`,
          content: `Memory from: ${c.pageContent}`,
          embedding: [0.1, 0.2],
          timestamp: new Date(),
          type: "fact" as const,
          metadata: { source: "test-memory" },
        })),
      },
      metrics: { memoryCount: chunks.length },
    };
  }
  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

class TestGeneratorModule implements BaseModule {
  readonly name = "TestGenerator";
  readonly version = "1.0.0";

  async process(input: ModuleInput): Promise<ModuleOutput> {
    const units = (input.data.memoryUnits as any[]) ?? [];
    const answer = `Generated answer from ${units.length} memory units about: ${input.data.query ?? "unknown"}`;
    return {
      data: { finalAnswer: answer, confidence: 0.88 },
      metrics: { answerLength: answer.length },
    };
  }
  getConfigSchema() { return z.object({}); }
  supportsLearning() { return false; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Full Pipeline Integration", () => {
  beforeEach(() => {
    ModuleRegistry.reset();
    const registry = ModuleRegistry.getInstance();
    registry.register("TestChunker", TestChunkerModule as any);
    registry.register("TestMemory", TestMemoryModule as any);
    registry.register("TestGenerator", TestGeneratorModule as any);
  });

  afterEach(() => {
    ModuleRegistry.reset();
  });

  it("should execute a 3-stage pipeline end-to-end", async () => {
    const engine = new WorkflowEngine({
      name: "integration-test",
      version: "1.0",
      entry: "chunk",
      stages: [
        { id: "chunk", module: "TestChunker", config: {}, next: "memory" },
        { id: "memory", module: "TestMemory", config: {}, next: "generate" },
        { id: "generate", module: "TestGenerator", config: {} },
      ],
    });

    await engine.initialize({});

    try {
      const state = await engine.run({ query: "What is S2 chunking?" });

      // All 3 stages should execute
      expect(state.history.length).toBe(3);
      expect(state.history.map((h) => h.stage)).toEqual(["chunk", "memory", "generate"]);

      // Data should flow through: query → chunks → memory → answer
      expect(state.data.chunks).toBeDefined();
      expect((state.data.chunks as Document[]).length).toBe(2);
      expect(state.data.memoryUnits).toBeDefined();
      expect((state.data.memoryUnits as any[]).length).toBe(2);
      expect(state.data.finalAnswer).toBeDefined();
      expect(state.data.finalAnswer).toContain("2 memory units");
      expect(state.data.finalAnswer).toContain("S2 chunking");
      expect(state.data.confidence).toBe(0.88);

      // Metrics should accumulate
      expect(state.data.metrics?.chunkCount).toBe(2);
      expect(state.data.metrics?.memoryCount).toBe(2);
      expect(state.data.metrics?.answerLength).toBeGreaterThan(0);

      // Timing
      expect(state.metadata.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(state.metadata.endTime).toBeDefined();

      // No errors
      expect(state.errors.length).toBe(0);
    } finally {
      await engine.shutdown();
    }
  });

  it("should preserve initial input data through the pipeline", async () => {
    const engine = new WorkflowEngine({
      name: "input-preservation",
      version: "1.0",
      entry: "chunk",
      stages: [
        { id: "chunk", module: "TestChunker", config: {}, next: "generate" },
        { id: "generate", module: "TestGenerator", config: {} },
      ],
    });

    await engine.initialize({});

    try {
      const state = await engine.run({
        query: "Custom query",
        customField: "should persist",
      });

      expect(state.data.query).toBe("Custom query");
      expect(state.data.customField).toBe("should persist");
      expect(state.data.finalAnswer).toContain("Custom query");
    } finally {
      await engine.shutdown();
    }
  });

  it("should handle learning loop iterations", async () => {
    const engine = new WorkflowEngine({
      name: "learning-test",
      version: "1.0",
      entry: "chunk",
      stages: [{ id: "chunk", module: "TestChunker", config: {} }],
      meta: { learning: true, maxIterations: 3 },
    });

    await engine.initialize({});

    try {
      const state = await engine.run({ query: "Learning test" });

      // Should have run 3 iterations and kept the best
      expect(state.history.length).toBeGreaterThan(0);
    } finally {
      await engine.shutdown();
    }
  });
});
