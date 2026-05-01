import { describe, it, expect } from "bun:test";
import { LightRAGRetrieverModule } from "../../modules/retrieval/LightRAGRetrieverModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";

describe("LightRAGRetrieverModule", () => {
  it("should return empty result for empty query", async () => {
    const { ctx } = createMockContext();
    const mod = new LightRAGRetrieverModule();
    await mod.init(ctx);

    const output = await mod.process(buildInput({ query: "" }), ctx);
    expect(output.data.retrievalResult).toBeDefined();
    expect(output.data.retrievalResult!.chunks.length).toBe(0);
    expect(output.metrics?.hits).toBe(0);
  });

  it("should attempt vector, graph, and keyword search", async () => {
    const { ctx, mocks } = createMockContext({
      llm: { responses: ['{"type": "fact", "scope": "full"}'] },
    });
    const mod = new LightRAGRetrieverModule({
      topK: 5,
      useVector: true,
      useGraph: true,
      intentAware: true,
      usePyramid: false,
    });
    await mod.init(ctx);

    const output = await mod.process(buildInput({ query: "What is S2 chunking?" }), ctx);

    expect(output.data.retrievalResult).toBeDefined();
    // Even with empty results from mocks, the module should complete without error
    expect(output.metrics?.vectorHits).toBeDefined();
    expect(output.metrics?.graphHits).toBeDefined();
  });

  it("should handle embedding failure gracefully", async () => {
    const { ctx } = createMockContext({
      embeddings: { shouldFail: true },
      llm: { responses: ['{"type": "fact", "scope": "full"}'] },
    });
    const mod = new LightRAGRetrieverModule({ intentAware: false });
    await mod.init(ctx);

    // Should not throw — falls back to zero vector
    const output = await mod.process(
      buildInput({ query: "Test query" }),
      ctx,
    );
    expect(output.data.retrievalResult).toBeDefined();
  });

  it("should produce metrics for all search modes", async () => {
    const { ctx } = createMockContext();
    const mod = new LightRAGRetrieverModule({ intentAware: false });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({ query: "Healthcare in Hong Kong" }),
      ctx,
    );

    expect(output.metrics).toHaveProperty("vectorHits");
    expect(output.metrics).toHaveProperty("graphHits");
    expect(output.metrics).toHaveProperty("keywordHits");
    expect(output.metrics).toHaveProperty("finalChunks");
    expect(output.metrics).toHaveProperty("avgScore");
  });
});
