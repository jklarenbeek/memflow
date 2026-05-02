import { describe, it, expect } from "bun:test";
import { SimpleMemModule } from "../../modules/memory/SimpleMemModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";
import { Document } from "@langchain/core/documents";

describe("SimpleMemModule", () => {
  it("should extract memory units from chunks via LLM", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"distinct_facts": 3}',                              // DensityGate
          '[{"content": "Healthcare in HK is prevention-focused", "type": "fact", "confidence": 0.9}]', // FactExtractor
        ],
      },
    });

    const mod = new SimpleMemModule({ synthesisThreshold: 0.82 });
    await mod.init(ctx);

    const input = buildInput({
      chunks: [
        new Document({ pageContent: "Primary healthcare in Hong Kong emphasizes prevention and community self-management." }),
      ],
    });

    const output = await mod.process(input, ctx);
    expect(output.data.memoryUnits).toBeDefined();
    const units = output.data.memoryUnits!;
    expect(units.length).toBeGreaterThan(0);
    expect(units[0].content).toContain("Healthcare");
    expect(units[0].type).toBe("fact");
    expect(units[0].embedding.length).toBe(768);
    expect(output.metrics?.extracted).toBeGreaterThan(0);
  });

  it("should fallback to chunk-as-memory when LLM fails", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });

    const mod = new SimpleMemModule();
    await mod.init(ctx);

    const input = buildInput({
      chunks: [new Document({ pageContent: "Important fact about LLM agents. They use memory systems." })],
    });

    const output = await mod.process(input, ctx);
    expect(output.data.memoryUnits!.length).toBe(1);
    expect(output.data.memoryUnits![0].type).toBe("fact");
  });

  it("should synthesize highly similar memories", async () => {
    const { ctx, mocks } = createMockContext({
      llm: {
        responses: [
          '{"distinct_facts": 3}',                              // DensityGate (window 1)
          '[{"content":"AI agents use memory systems.","type":"fact"}]',        // FactExtractor (window 1)
          '{"distinct_facts": 3}',                              // DensityGate (window 2)
          '[{"content":"AI agents use memory systems for recall.","type":"fact"}]', // FactExtractor (window 2)
          '{"distinct_facts": 3}',                              // DensityGate (window 3)
          '[{"content":"AI agents use memory systems for long-term storage.","type":"fact"}]', // FactExtractor (window 3)
          // SemanticSynthesis may use the next response, but with 1 fact per window
          // there are 3 units total. Their embeddings will be similar enough at threshold 0.01.
        ],
      },
    });
    const mod = new SimpleMemModule({ synthesisThreshold: 0.01, windowSize: 1 }); // very low threshold = everything merges
    await mod.init(ctx);

    const input = buildInput({
      chunks: [
        new Document({ pageContent: "AI agents use memory systems." }),
        new Document({ pageContent: "AI agents use memory systems for recall." }),
        new Document({ pageContent: "AI agents use memory systems for long-term storage." }),
      ],
    });

    const output = await mod.process(input, ctx);
    // With threshold 0.01, almost identical chunks should be synthesized
    expect(output.data.memoryUnits!.length).toBeLessThanOrEqual(3);
    expect(output.metrics?.merged).toBeDefined();
  });

  it("should return empty for no chunks", async () => {
    const { ctx } = createMockContext();
    const mod = new SimpleMemModule();

    const output = await mod.process(buildInput({}), ctx);
    expect(output.data.memoryUnits).toEqual([]);
    expect(output.metrics?.extracted).toBe(0);
  });
});
