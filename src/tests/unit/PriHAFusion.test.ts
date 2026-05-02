import { describe, it, expect } from "bun:test";
import { PriHAFusionModule } from "../../modules/generation/PriHAFusionModule.js";
import { createMockContext, buildInput } from "../helpers/mocks.js";
import { Document } from "@langchain/core/documents";
import type { RetrievalResult } from "../../core/types.js";

describe("PriHAFusionModule", () => {
  const makeRetrieval = (chunks: string[]): RetrievalResult => ({
    chunks: chunks.map((c) => new Document({ pageContent: c, metadata: { source: "test" } })),
    memories: [],
    graphPaths: [],
    score: 0.85,
    sources: ["test-source"],
  });

  it("should generate an answer from retrieval context", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          "Primary healthcare in HK emphasizes prevention. [1]",
          "VALID",
        ],
      },
    });

    const mod = new PriHAFusionModule({
      enableTriage: false,
      enableDualSource: false,
      enableValidation: true,
    });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        query: "What is primary healthcare in HK?",
        retrievalResult: makeRetrieval(["HK emphasizes prevention and community care."]),
      }),
      ctx,
    );

    expect(output.data.finalAnswer).toBeDefined();
    expect(output.data.finalAnswer).toContain("prevention");
    expect(output.data.confidence).toBeGreaterThan(0);
    expect(output.data.sources!.length).toBeGreaterThan(0);
  });

  it("should append validation note for unsupported claims", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          "The earth is flat according to the guidelines.",
          "ISSUES: Claim about flat earth is not supported by context",
        ],
      },
    });

    const mod = new PriHAFusionModule({
      enableTriage: false,
      enableDualSource: false,
      enableValidation: true,
    });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        query: "Shape of earth",
        retrievalResult: makeRetrieval(["The earth is round."]),
      }),
      ctx,
    );

    expect(output.data.finalAnswer).toContain("VALIDATION NOTE");
  });

  it("should add inline citations when missing", async () => {
    // With enableTriage=false, QueryClarifier skips its LLM call (maxClarificationDepth=0).
    // Only AnswerGenerator and HallucinationValidator invoke the LLM.
    const { ctx } = createMockContext({
      llm: { responses: ["Answer without any citations.", "VALID"] },
    });

    const mod = new PriHAFusionModule({
      enableTriage: false,
      enableValidation: true,
      citationStyle: "inline",
    });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        query: "Test",
        retrievalResult: makeRetrieval(["Evidence"]),
      }),
      ctx,
    );

    expect(output.data.finalAnswer).toContain("Sources:");
    expect(output.data.finalAnswer).toContain("[1]");
  });

  it("should triage fuzzy queries", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"clarifications": ["Which aspect?"], "subqueries": ["best healthcare prevention methods"]}',
          "Prevention is key in HK healthcare.",
          "VALID",
        ],
      },
    });

    const mod = new PriHAFusionModule({
      enableTriage: true,
      enableValidation: true,
    });
    await mod.init(ctx);

    const output = await mod.process(
      buildInput({
        query: "what is best",
        retrievalResult: makeRetrieval(["HK healthcare"]),
      }),
      ctx,
    );

    expect(output.data.finalAnswer).toBeDefined();
    expect(output.metrics?.subQueries).toBe(1);
  });
});
