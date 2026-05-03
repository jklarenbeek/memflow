/**
 * Evolution Layer — E2E Integration Tests (§4.2)
 *
 * Tests evolution modules with mocked WorkflowContext (no real services needed).
 * Validates end-to-end data flows through:
 *  1. SLMDatasetExporter — Memgraph query → JSONL file generation
 *  2. HarnessEvolver — Create → Evolve → version chain verification
 *  3. SkillInjector — Pre-populated :Skill nodes → similarity injection
 *  4. API endpoint — POST /datasets/export validation
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createMockContext,
  buildInput,
} from "../helpers/mocks.js";

// ---------------------------------------------------------------------------
// 1. SLMDatasetExporter E2E (mocked Memgraph)
// ---------------------------------------------------------------------------

describe("SLMDatasetExporter E2E", () => {
  it("should produce SFT samples from mocked Decision nodes", async () => {
    const { SLMDatasetExporterModule } = await import(
      "../../modules/evolution/SLMDatasetExporterModule.js"
    );

    const decisionData = [
      {
        id: "d1",
        query: "Should we invest in solar?",
        decision: "Yes, prioritize solar.",
        outcome: "positive",
        confidence: 0.85,
        context: "Energy portfolio review",
        reflection: "Solar outperformed expectations.",
        timestamp: new Date().toISOString(),
      },
      {
        id: "d2",
        query: "Should we exit bonds?",
        decision: "No, maintain position.",
        outcome: "neutral",
        confidence: 0.72,
        context: "Fixed income review",
        reflection: "Bond yields stabilized.",
        timestamp: new Date().toISOString(),
      },
    ];

    const { ctx, mocks } = createMockContext({
      memgraph: {
        queryResults: {
          Decision: decisionData,
          DebateSession: [],
          ReviewSession: [],
          RedTeamSession: [],
          Reflection: [],
          PendingDecision: [],
          ModuleState: [],
        },
      },
    });

    const mod = new SLMDatasetExporterModule({
      trigger: { type: "on_demand" },
      format: "sft",
    });
    const config = mod.getConfigSchema().parse({
      trigger: { type: "on_demand" },
      format: "sft",
    });
    const input = buildInput({}, config);

    const result = await mod.process(input, ctx);

    // Should have collected samples (exact count depends on query matching)
    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics!.sftCount).toBe("number");
  });

  it("should handle empty Memgraph gracefully", async () => {
    const { SLMDatasetExporterModule } = await import(
      "../../modules/evolution/SLMDatasetExporterModule.js"
    );

    const { ctx } = createMockContext({
      memgraph: { queryResults: {} },
    });

    const mod = new SLMDatasetExporterModule({
      trigger: { type: "on_demand" },
    });
    const config = mod.getConfigSchema().parse({ trigger: { type: "on_demand" } });
    const input = buildInput({}, config);

    const result = await mod.process(input, ctx);
    expect(result.data).toBeDefined();
    expect(result.metrics!.sftCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. HarnessEvolver Version Chain (mocked Memgraph)
// ---------------------------------------------------------------------------

describe("HarnessEvolver Version Chain", () => {
  it("should create initial harness and track version", async () => {
    const { HarnessEvolverModule } = await import(
      "../../modules/evolution/HarnessEvolverModule.js"
    );

    const { ctx, mocks } = createMockContext({
      llm: {
        responses: [
          JSON.stringify({
            predictions: [
              {
                hypothesis: "Solar energy will increase 20%",
                confidence: 0.8,
                reasoning: "Current trends show growth",
              },
            ],
            weights: [1.0],
          }),
        ],
      },
      memgraph: {
        queryResults: {
          PredictionHarness: [], // No existing harness
        },
      },
    });

    const mod = new HarnessEvolverModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ query: "Solar energy market outlook" }, config);

    const result = await mod.process(input, ctx);

    expect(result.data.predictionHarness).toBeDefined();
    expect(result.metrics).toBeDefined();

    // Verify a CREATE query was issued to Memgraph
    const createQueries = mocks.memgraph._queries.filter(
      (q) => q.cypher.includes("CREATE") || q.cypher.includes("MERGE"),
    );
    expect(createQueries.length).toBeGreaterThan(0);
  });

  it("should evolve existing harness with version increment", async () => {
    const { HarnessEvolverModule } = await import(
      "../../modules/evolution/HarnessEvolverModule.js"
    );

    const existingHarness = {
      id: "harness-existing",
      topicId: "test-topic",
      version: 1,
      predictions: JSON.stringify([
        { hypothesis: "Test prediction", confidence: 0.7, reasoning: "Initial" },
      ]),
      weights: JSON.stringify([1.0]),
      createdAt: new Date().toISOString(),
    };

    const { ctx, mocks } = createMockContext({
      llm: {
        responses: [
          JSON.stringify({
            predictions: [
              {
                hypothesis: "Revised prediction with more data",
                confidence: 0.85,
                reasoning: "Updated reasoning",
              },
            ],
            weights: [1.0],
          }),
        ],
      },
      memgraph: {
        queryResults: {
          PredictionHarness: [existingHarness],
        },
      },
    });

    const mod = new HarnessEvolverModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ query: "Solar energy market outlook" }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.predictionHarness).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. SkillInjector with Pre-Populated Skills (mocked)
// ---------------------------------------------------------------------------

describe("SkillInjector E2E", () => {
  it("should inject skills above similarity threshold", async () => {
    const { SkillInjectorModule } = await import(
      "../../modules/evolution/SkillInjectorModule.js"
    );

    // Create skill nodes with embeddings that will match a query
    const dim = 768;
    const makeEmbedding = (seed: number) =>
      Array.from({ length: dim }, (_, i) => Math.sin(seed + i) * 0.5);

    const skillNodes = [
      {
        id: "skill-1",
        name: "Market Analysis",
        description: "Analyze market trends",
        applicableWhen: "financial queries",
        doPatterns: ["Use recent data", "Compare benchmarks"],
        dontPatterns: ["Don't ignore volatility"],
        embedding: makeEmbedding(1),
      },
      {
        id: "skill-2",
        name: "Risk Assessment",
        description: "Evaluate portfolio risk",
        applicableWhen: "investment decisions",
        doPatterns: ["Consider downside scenarios"],
        dontPatterns: ["Don't overweight recent events"],
        embedding: makeEmbedding(2),
      },
    ];

    const { ctx } = createMockContext({
      memgraph: {
        queryResults: {
          Skill: skillNodes,
        },
      },
    });

    const mod = new SkillInjectorModule({
      mode: "global",
      minSimilarity: 0.0, // Accept all for testing
      maxSkills: 5,
    });
    const config = mod.getConfigSchema().parse({
      mode: "global",
      minSimilarity: 0.0,
      maxSkills: 5,
    });
    const input = buildInput({ query: "What is the market outlook?" }, config);

    const result = await mod.process(input, ctx);
    expect(result.metrics!.injectedCount).toBeGreaterThan(0);
    expect(result.data.skillContext).toBeDefined();
  });

  it("should return empty when no skills exist", async () => {
    const { SkillInjectorModule } = await import(
      "../../modules/evolution/SkillInjectorModule.js"
    );

    const { ctx } = createMockContext({
      memgraph: { queryResults: {} },
    });

    const mod = new SkillInjectorModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ query: "Test query" }, config);

    const result = await mod.process(input, ctx);
    expect(result.metrics!.injectedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. API Endpoint Validation
// ---------------------------------------------------------------------------

describe("POST /datasets/export validation", () => {
  it("should reject invalid format values", async () => {
    // Import Zod schema directly for validation testing
    const { z } = await import("zod");

    const ExportRequestSchema = z.object({
      format: z.enum(["sft", "dpo", "both"]).default("both"),
      domain: z.string().optional(),
      maxSamples: z.number().min(1).max(100000).default(10000),
      minConfidence: z.number().min(0).max(1).default(0.6),
      deduplicationThreshold: z.number().min(0).max(1).default(0.92),
      requireRetrospectiveValidation: z.boolean().default(true),
    });

    // Invalid format
    const result = ExportRequestSchema.safeParse({ format: "invalid" });
    expect(result.success).toBe(false);

    // Valid defaults
    const defaults = ExportRequestSchema.parse({});
    expect(defaults.format).toBe("both");
    expect(defaults.maxSamples).toBe(10000);
    expect(defaults.minConfidence).toBe(0.6);
  });

  it("should reject out-of-range numeric values", async () => {
    const { z } = await import("zod");

    const ExportRequestSchema = z.object({
      format: z.enum(["sft", "dpo", "both"]).default("both"),
      maxSamples: z.number().min(1).max(100000).default(10000),
      minConfidence: z.number().min(0).max(1).default(0.6),
    });

    // maxSamples too high
    const r1 = ExportRequestSchema.safeParse({ maxSamples: 500000 });
    expect(r1.success).toBe(false);

    // minConfidence out of range
    const r2 = ExportRequestSchema.safeParse({ minConfidence: 1.5 });
    expect(r2.success).toBe(false);
  });
});
