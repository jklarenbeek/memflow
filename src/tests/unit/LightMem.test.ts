import { describe, it, expect } from "bun:test";
import { LightMemModule } from "../../modules/memory/LightMemModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";
import type { MemoryUnit } from "../../core/types.js";

function makeUnit(content: string, embedding: number[], confidence = 0.8): MemoryUnit {
  return {
    id: `unit-${Math.random().toString(36).slice(2, 8)}`,
    content,
    embedding,
    timestamp: new Date(),
    type: "fact",
    metadata: { confidence },
  };
}

describe("LightMemModule", () => {
  it("should filter redundant memories above novelty threshold", async () => {
    const { ctx } = createMockContext();
    const mod = new LightMemModule({ noveltyThreshold: 0.99 }); // very strict = filters almost everything
    await mod.init(ctx);

    // Create units with identical embeddings → should be filtered
    const sharedEmb = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.5);
    const units = [
      makeUnit("Original fact", sharedEmb),
      makeUnit("Same fact rephrased", [...sharedEmb]), // identical embedding
      makeUnit("Another duplicate", [...sharedEmb]),
    ];

    const input = buildInput({ memoryUnits: units });
    const output = await mod.process(input, ctx);

    // Second and third should be filtered (identical embeddings = sim 1.0 > 0.99)
    expect(output.data.memoryUnits!.length).toBeLessThan(3);
    expect(output.metrics?.filtered).toBeGreaterThan(0);
  });

  it("should keep novel memories below threshold", async () => {
    const { ctx } = createMockContext();
    const mod = new LightMemModule({ noveltyThreshold: 0.99 });
    await mod.init(ctx);

    // Create units with very different embeddings
    const units = [
      makeUnit("Fact about healthcare", Array.from({ length: 768 }, () => 0.1)),
      makeUnit("Fact about quantum physics", Array.from({ length: 768 }, () => -0.5)),
    ];

    const input = buildInput({ memoryUnits: units });
    const output = await mod.process(input, ctx);

    expect(output.data.memoryUnits!.length).toBe(2);
    expect(output.metrics?.filtered).toBe(0);
  });

  it("should trigger sleep consolidation when approaching capacity", async () => {
    const { ctx } = createMockContext({
      llm: { responses: ["Abstract: Combined knowledge about multiple topics."] },
    });
    const mod = new LightMemModule({
      maxMemoryUnits: 10,
      consolidationTrigger: 0.5,
      compressionRatio: 0.3,
    });
    await mod.init(ctx);

    // Create 8 units (> 10 * 0.5 = 5 trigger)
    const units = Array.from({ length: 8 }, (_, i) =>
      makeUnit(`Fact number ${i}`, Array.from({ length: 768 }, (_, j) => Math.sin(i * 100 + j) * 0.5)),
    );

    const input = buildInput({ memoryUnits: units });
    const output = await mod.process(input, ctx);

    expect(output.data.memoryUnits!.length).toBeLessThanOrEqual(8);
    expect(output.metrics?.afterConsolidation).toBeDefined();
  });

  it("should handle empty input", async () => {
    const { ctx } = createMockContext();
    const mod = new LightMemModule();

    const output = await mod.process(buildInput({}), ctx);
    expect(output.data.memoryUnits).toEqual([]);
  });
});
