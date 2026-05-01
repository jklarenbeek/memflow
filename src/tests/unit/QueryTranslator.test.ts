import { describe, it, expect } from "bun:test";
import { QueryTranslatorModule } from "../../modules/query/QueryTranslatorModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";

describe("QueryTranslatorModule", () => {
  it("should expand query with HyDE technique", async () => {
    const { ctx } = createMockContext({
      llm: { responses: ["S2 chunking is a framework that combines spatial and semantic analysis to segment documents into coherent chunks."] },
    });

    const mod = new QueryTranslatorModule({ techniques: ["hyde"], useLLM: true });
    await mod.init(ctx);

    const output = await mod.process(buildInput({ query: "What is S2 chunking?" }), ctx);

    expect(output.data.expandedQueries!.length).toBeGreaterThan(1);
    expect(output.data.expandedQueries![0]).toBe("What is S2 chunking?");
    expect(output.metrics?.queryVariants).toBeGreaterThan(1);
  });

  it("should expand with multiple techniques", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          "Hypothetical document about S2 chunking.",
          '["How does S2 chunking work?", "S2 chunking implementation"]',
          "What are document segmentation methods?",
        ],
      },
    });

    const mod = new QueryTranslatorModule({
      techniques: ["hyde", "multi_query", "step_back"],
      useLLM: true,
    });
    await mod.init(ctx);

    const output = await mod.process(buildInput({ query: "S2 chunking" }), ctx);

    expect(output.data.expandedQueries!.length).toBeGreaterThanOrEqual(4);
    expect(output.metrics?.techniqueCount).toBe(3);
  });

  it("should use fallback templates when useLLM is false", async () => {
    const { ctx } = createMockContext();
    const mod = new QueryTranslatorModule({
      techniques: ["hyde", "multi_query"],
      useLLM: false,
    });

    const output = await mod.process(buildInput({ query: "Test query" }), ctx);

    expect(output.data.expandedQueries!.length).toBe(4); // original + 1 hyde + 2 multi_query
    expect(output.data.expandedQueries![1]).toContain("Hypothetical document");
    expect(output.data.expandedQueries![2]).toContain("pros and cons");
  });

  it("should fallback to templates on LLM failure", async () => {
    const { ctx } = createMockContext({ llm: { shouldFail: true } });
    const mod = new QueryTranslatorModule({ techniques: ["hyde"], useLLM: true });
    await mod.init(ctx);

    const output = await mod.process(buildInput({ query: "Test" }), ctx);

    // Should not throw, should use fallback
    expect(output.data.expandedQueries!.length).toBe(2);
  });
});
