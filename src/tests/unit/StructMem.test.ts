import { describe, it, expect } from "bun:test";
import { StructMemModule } from "../../modules/memory/StructMemModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";
import type { MemoryUnit } from "../../core/types.js";

describe("StructMemModule", () => {
  it("should add temporal anchoring and entities to units", async () => {
    const { ctx } = createMockContext();
    const mod = new StructMemModule({ persistToGraph: false });
    await mod.init(ctx);

    const units: MemoryUnit[] = [
      {
        id: "u1",
        content: "Hong Kong government published the Primary Healthcare Blueprint.",
        embedding: Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.3),
        timestamp: new Date(),
        type: "fact",
        metadata: {},
      },
    ];

    const input = buildInput({ memoryUnits: units });
    const output = await mod.process(input, ctx);

    const processed = output.data.memoryUnits!;
    expect(processed[0].metadata.temporal).toBeDefined();
    expect(processed[0].metadata.entities).toBeDefined();
    expect(processed[0].metadata.entities!.length).toBeGreaterThan(0);
    expect(processed[0].metadata.entities).toContain("Hong Kong");
  });

  it("should bind relations between similar units", async () => {
    const { ctx } = createMockContext();
    const mod = new StructMemModule({ relationThreshold: 0.5, persistToGraph: false });
    await mod.init(ctx);

    // Two units with identical embeddings → should be linked
    const sharedEmb = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.5);
    const units: MemoryUnit[] = [
      { id: "u1", content: "Fact A", embedding: sharedEmb, timestamp: new Date(), type: "fact", metadata: {} },
      { id: "u2", content: "Fact B", embedding: [...sharedEmb], timestamp: new Date(), type: "fact", metadata: {} },
    ];

    const input = buildInput({ memoryUnits: units });
    const output = await mod.process(input, ctx);

    const processed = output.data.memoryUnits!;
    expect(processed[0].relations).toBeDefined();
    expect(processed[0].relations!.length).toBeGreaterThan(0);
    expect(processed[0].relations![0].targetId).toBe("u2");
    expect(output.metrics?.withRelations).toBeGreaterThan(0);
  });

  it("should persist to Memgraph when enabled", async () => {
    const { ctx, mocks } = createMockContext();
    const mod = new StructMemModule({ persistToGraph: true, persistBatchSize: 10 });
    await mod.init(ctx);

    const units: MemoryUnit[] = [
      { id: "u1", content: "Fact", embedding: [0.1], timestamp: new Date(), type: "fact", metadata: {} },
    ];

    const input = buildInput({ memoryUnits: units });
    await mod.process(input, ctx);

    expect(mocks.memgraph._queryCount()).toBeGreaterThan(0);
  });

  it("should handle empty input", async () => {
    const { ctx } = createMockContext();
    const mod = new StructMemModule({ persistToGraph: false });

    const output = await mod.process(buildInput({}), ctx);
    expect(output.data.memoryUnits).toEqual([]);
  });
});
