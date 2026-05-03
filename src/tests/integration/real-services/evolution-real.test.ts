/**
 * Evolution Layer — Real-Service Integration Tests (§4.2 → P4)
 *
 * Full LLM + Memgraph integration tests for evolution modules.
 * Tests are gated by EVOLUTION_REAL_TESTS=1 (set automatically in CI).
 *
 * Supports multiple LLM providers:
 *   - Ollama (local):     LLM_PROVIDER=ollama
 *   - OpenRouter (cloud):  LLM_PROVIDER=openrouter OPENROUTER_API_KEY=sk-...
 *   - OpenAI (cloud):      LLM_PROVIDER=openai OPENAI_API_KEY=sk-...
 *
 * To run locally with Ollama:
 *   EVOLUTION_REAL_TESTS=1 bun test src/tests/integration/real-services/evolution-real.test.ts
 *
 * To run with OpenRouter:
 *   EVOLUTION_REAL_TESTS=1 LLM_PROVIDER=openrouter EMBEDDING_PROVIDER=openrouter \
 *     OPENROUTER_API_KEY=sk-... bun test src/tests/integration/real-services/evolution-real.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  checkServiceHealth,
  createRealContext,
  cleanupEvolutionTestData,
  seedSkillNodes,
  LLM_TIMEOUT,
  PIPELINE_TIMEOUT,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import type { WorkflowContext } from "../../../core/WorkflowContext.js";

// Module imports
import { HarnessEvolverModule } from "../../../modules/evolution/HarnessEvolverModule.js";
import { SkillInjectorModule } from "../../../modules/evolution/SkillInjectorModule.js";
import { IntentCompilerModule } from "../../../modules/core/IntentCompilerModule.js";
import { SkillBasisExtractorModule } from "../../../modules/evolution/SkillBasisExtractorModule.js";
import { WorkflowEngine } from "../../../core/WorkflowEngine.js";
import { ModuleRegistry } from "../../../core/ModuleRegistry.js";

const RUN_REAL_TESTS = process.env.EVOLUTION_REAL_TESTS === "1";

describe.skipIf(!RUN_REAL_TESTS)("Evolution Layer (real services)", () => {
  let ctx: WorkflowContext;

  beforeAll(async () => {
    const health = await checkServiceHealth();
    if (!health.memgraph) throw new Error("Memgraph not available");
    ctx = await createRealContext();
  });

  afterAll(async () => {
    if (ctx) {
      await cleanupEvolutionTestData(ctx.memgraph);
      await ctx.shutdown();
    }
  });

  beforeEach(async () => {
    // Clean slate for each test
    await cleanupEvolutionTestData(ctx.memgraph);
  });

  // -----------------------------------------------------------------------
  // Test 1: HarnessEvolver retrospective cycle
  //
  // Create → Evolve → Retrospective: full lifecycle of a prediction harness
  // with real LLM calls for feedback generation and validation.
  // -----------------------------------------------------------------------

  test(
    "HarnessEvolver retrospective — create → evolve → retrospective validates outcome",
    async () => {
      const mod = new HarnessEvolverModule({});
      await mod.init(ctx);

      // Step 1: Create a new harness
      const createResult = await mod.process(
        { data: { query: "__evo_test__ stock prediction for tech sector Q1" }, config: {} as any },
        ctx,
      );

      expect(createResult.metrics?.mode).toBe("create");
      expect(createResult.data.predictionHarness).toBeDefined();

      const harness = createResult.data.predictionHarness as {
        id: string; content: string; version: number; topicId: string;
      };
      expect(harness.id).toMatch(/^harness-/);
      expect(harness.version).toBe(1);
      expect(harness.content.length).toBeGreaterThan(0);

      // Verify persisted to Memgraph
      const persisted = await ctx.memgraph.query<{ id: string }>(
        `MATCH (h:PredictionHarness {id: $id}) RETURN h.id AS id`,
        { id: harness.id },
      );
      expect(persisted.length).toBe(1);

      // Step 2: Evolve with a new observation
      const evolveResult = await mod.process(
        { data: { query: "__evo_test__ stock prediction for tech sector Q1" }, config: {} as any },
        ctx,
      );

      expect(evolveResult.metrics?.mode).toBe("evolve");
      const evolvedHarness = evolveResult.data.predictionHarness as {
        id: string; content: string; version: number; topicId: string;
      };
      expect(evolvedHarness.version).toBe(2);
      expect(evolveResult.data.internalFeedback).toBeDefined();

      // Verify VERSION_OF edge
      const edges = await ctx.memgraph.query<{ newId: string; oldId: string }>(
        `MATCH (new:PredictionHarness {id: $newId})-[:VERSION_OF]->(old:PredictionHarness {id: $oldId})
         RETURN new.id AS newId, old.id AS oldId`,
        { newId: evolvedHarness.id, oldId: harness.id },
      );
      expect(edges.length).toBe(1);

      // Step 3: Retrospective check against an outcome
      const retroResult = await mod.process(
        {
          data: {
            predictionHarness: evolvedHarness,
            outcomeResolution: {
              pendingId: "test-pending",
              result: {
                outcome: "Tech stocks rose 5% in Q1 2026 driven by AI demand",
                summary: "Prediction was directionally correct — tech sector performance validated",
              },
            },
          },
          config: {} as any,
        },
        ctx,
      );

      expect(retroResult.metrics?.mode).toBe("retrospective");
      // The LLM may or may not validate; we just verify the flow completes
      expect(retroResult.data.internalFeedback).toBeDefined();
      expect(typeof retroResult.metrics?.validated).toBe("boolean");
    },
    { timeout: LLM_TIMEOUT },
  );

  // -----------------------------------------------------------------------
  // Test 2: SkillInjector with real embeddings
  //
  // Seed :Skill nodes with real embeddings, then query with a semantically
  // related prompt and verify that relevant skills are injected.
  // -----------------------------------------------------------------------

  test(
    "SkillInjector with real skills — pre-populate :Skill nodes with embeddings, verify relevant skills are injected by similarity",
    async () => {
      // Seed 3 skills with real embeddings
      const testSkills = [
        {
          id: "__evo_test__skill-rag",
          name: "RAG Pipeline Design",
          description: "Best practices for building retrieval-augmented generation pipelines with vector search and graph traversal",
          applicableWhen: "The user asks about building RAG systems or information retrieval",
          doPatterns: ["Use hybrid retrieval (vector + graph)", "Include re-ranking"],
          dontPatterns: ["Skip embedding quality checks"],
        },
        {
          id: "__evo_test__skill-debug",
          name: "Error Debugging Strategy",
          description: "Systematic approach to debugging runtime errors in distributed systems",
          applicableWhen: "The user encounters errors or unexpected behavior",
          doPatterns: ["Check logs first", "Reproduce minimally"],
          dontPatterns: ["Guess without evidence"],
        },
        {
          id: "__evo_test__skill-memgraph",
          name: "Graph Database Schema Design",
          description: "Designing efficient Memgraph schemas with proper indexes and relationship patterns",
          applicableWhen: "The user needs to design or optimize graph database schemas",
          doPatterns: ["Create indexes on frequently queried properties", "Use MERGE over CREATE"],
          dontPatterns: ["Store large blobs as node properties"],
        },
      ];

      await seedSkillNodes(ctx, testSkills);

      // Verify skills are seeded
      const count = await ctx.memgraph.query<{ cnt: number }>(
        `MATCH (s:Skill) WHERE s.id STARTS WITH '__evo_test__' RETURN count(s) AS cnt`,
      );
      expect(Number(count[0]?.cnt)).toBe(3);

      // Run SkillInjector with a RAG-related query (should match skill-rag)
      const mod = new SkillInjectorModule({
        mode: "global",
        maxSkills: 3,
        minSimilarity: 0.3, // Lower threshold for test robustness across embedding models
      });

      const result = await mod.process(
        { data: { query: "How do I build a retrieval-augmented generation pipeline?" }, config: {} as any },
        ctx,
      );

      expect(result.metrics?.injectedCount).toBeGreaterThan(0);
      expect(result.data.skillContext).toBeDefined();
      expect(typeof result.data.skillContext).toBe("string");
      expect((result.data.skillContext as string).length).toBeGreaterThan(0);

      // Verify injected skills list is traced
      if (result.data.injectedSkills) {
        const injected = result.data.injectedSkills as string[];
        expect(injected.length).toBeGreaterThan(0);
        // The RAG skill should be among the top matches
        const hasRagSkill = injected.some((s) => s.includes("RAG"));
        expect(hasRagSkill).toBe(true);
      }
    },
    { timeout: LLM_TIMEOUT },
  );

  // -----------------------------------------------------------------------
  // Test 3: IntentCompiler LLM validation
  //
  // Generate a workflow JSON from a natural language intent using a real
  // LLM, then validate the output structure.
  // -----------------------------------------------------------------------

  test(
    "IntentCompiler validation — real LLM generates parseable workflow JSON",
    async () => {
      const mod = new IntentCompilerModule({
        maxRetries: 3,
        outputDir: "", // Don't write to disk in tests
      });

      const result = await mod.process(
        {
          data: {
            query: "Build a simple RAG pipeline that chunks documents, indexes them in the graph, and generates answers with citations",
          },
          config: {} as any,
        },
        ctx,
      );

      expect(result.metrics?.success).toBe(true);
      expect(result.data.compiledWorkflow).toBeDefined();

      const workflow = result.data.compiledWorkflow as {
        name: string; version: string; entry: string;
        stages: Array<{ id: string; module: string }>;
      };

      // Validate structural integrity
      expect(typeof workflow.name).toBe("string");
      expect(workflow.name.length).toBeGreaterThan(0);
      expect(typeof workflow.version).toBe("string");
      expect(typeof workflow.entry).toBe("string");
      expect(Array.isArray(workflow.stages)).toBe(true);
      expect(workflow.stages.length).toBeGreaterThanOrEqual(2);

      // Verify entry stage exists
      const entryStage = workflow.stages.find((s) => s.id === workflow.entry);
      expect(entryStage).toBeDefined();

      // Verify all referenced modules exist in the registry
      const registry = ModuleRegistry.getInstance();
      for (const stage of workflow.stages) {
        expect(registry.hasModule(stage.module)).toBe(true);
      }
    },
    { timeout: LLM_TIMEOUT },
  );

  // -----------------------------------------------------------------------
  // Test 4: Full pipeline E2E (self-improving-research.json)
  //
  // Execute the full self-improving-research.json example workflow
  // end-to-end with real services. This is the most comprehensive test.
  // -----------------------------------------------------------------------

  test(
    "Full pipeline E2E — run self-improving-research.json example workflow end-to-end",
    async () => {
      // Load the workflow definition
      const workflow = (await import("../../../workflows/examples/self-improving-research.json", { with: { type: "json" } })).default;

      expect(workflow.name).toBe("self-improving-research");
      expect(workflow.stages.length).toBe(5);

      const engine = new WorkflowEngine(workflow);
      await engine.initializeWithContext(ctx);

      try {
        const state = await engine.run({
          query: "What are the best practices for building a self-improving RAG system that learns from user interactions?",
        });

        // Pipeline should complete — even if individual stages produce
        // minimal output, the engine should not crash
        // Note: some stages may produce soft errors that are collected
        // but don't halt execution
        expect(state).toBeDefined();
        expect(state.history.length).toBeGreaterThanOrEqual(1);

        // Verify stage execution order
        const executedStages = state.history.map((h) => h.stage);
        expect(executedStages[0]).toBe("compile");

        // If all stages completed, verify the full chain
        if (state.errors.length === 0) {
          expect(executedStages).toContain("compile");
          // Downstream stages depend on compile output
          expect(state.history.length).toBeGreaterThanOrEqual(2);
        }
      } finally {
        await engine.shutdown();
      }
    },
    { timeout: PIPELINE_TIMEOUT },
  );

  // -----------------------------------------------------------------------
  // Test 5: SkillBasisExtractor with ml-pca
  //
  // Generate experience entries with real embeddings and run PCA to
  // extract skill basis axes.
  // -----------------------------------------------------------------------

  test(
    "SkillBasisExtractor with ml-pca — provide >10 experience entries with embeddings, verify PCA axes are returned",
    async () => {
      // Check if ml-pca is available
      let pcaAvailable = true;
      try {
        await import("ml-pca" as string);
      } catch {
        pcaAvailable = false;
      }

      if (!pcaAvailable) {
        console.log("⚠ Skipping SkillBasisExtractor test: ml-pca not installed");
        return;
      }

      // Generate 15 diverse experience entries
      const experiences = [
        { context: "User asked about building a RAG pipeline", insight: "Use hybrid retrieval combining vector and graph search for best results", utility: 0.9 },
        { context: "User needed to debug a memory leak", insight: "Check for unclosed database connections and event listener accumulation", utility: 0.85 },
        { context: "User wanted to optimize embedding quality", insight: "Fine-tune embeddings on domain-specific data for 20-30% accuracy improvement", utility: 0.8 },
        { context: "User asked about graph schema design", insight: "Create indexes on frequently queried properties to avoid full graph scans", utility: 0.75 },
        { context: "User needed multi-agent orchestration", insight: "Use debate pattern for consensus and parallel dispatch for independent tasks", utility: 0.7 },
        { context: "User asked about chunking strategies", insight: "S2 spectral clustering outperforms fixed-size chunking for structured documents", utility: 0.9 },
        { context: "User wanted to implement sleep consolidation", insight: "Run consolidation during low-traffic periods to avoid query latency spikes", utility: 0.65 },
        { context: "User needed citation injection", insight: "Persist citation nodes to Memgraph for audit trail and provenance tracking", utility: 0.8 },
        { context: "User asked about workflow composition", insight: "Use SubWorkflow module for reusable pipeline fragments", utility: 0.75 },
        { context: "User wanted to reduce hallucinations", insight: "Add HallucinationValidator stage after generation with fact-checking prompt", utility: 0.95 },
        { context: "User needed real-time search", insight: "WebSearchAgent with Tavily API provides fresh context for time-sensitive queries", utility: 0.7 },
        { context: "User asked about entity extraction", insight: "Batch entity extraction with community detection improves graph cohesion", utility: 0.8 },
        { context: "User wanted to build a trading analysis system", insight: "Use Delphi panel pattern with fundamental, technical, and sentiment analysts", utility: 0.85 },
        { context: "User needed to handle contradictions", insight: "Contradiction module detects and resolves conflicting memory units", utility: 0.75 },
        { context: "User asked about SLM fine-tuning data", insight: "Export DPO pairs with retrospective validation for highest quality training data", utility: 0.9 },
      ];

      const mod = new SkillBasisExtractorModule({
        maxTrajectories: 100,
        numComponents: 3,
        topKSamplesPerAxis: 3,
      });

      const result = await mod.process(
        {
          data: { experienceLibrary: experiences },
          config: {} as any,
        },
        ctx,
      );

      const basis = result.data.skillBasis as Array<{
        axisId: number; variance: number; topSamples: string[]; label: string;
      }>;

      expect(Array.isArray(basis)).toBe(true);
      expect(basis.length).toBe(3);

      // Validate each axis
      for (const axis of basis) {
        expect(typeof axis.axisId).toBe("number");
        expect(axis.variance).toBeGreaterThan(0);
        expect(axis.variance).toBeLessThanOrEqual(1);
        expect(Array.isArray(axis.topSamples)).toBe(true);
        expect(axis.topSamples.length).toBeLessThanOrEqual(3);
        expect(typeof axis.label).toBe("string");
      }

      // Verify total variance is sane
      const totalVariance = result.metrics?.totalVarianceExplained as number;
      expect(totalVariance).toBeGreaterThan(0);
      expect(totalVariance).toBeLessThanOrEqual(1);

      // Axes should be ordered by descending variance
      for (let i = 1; i < basis.length; i++) {
        expect(basis[i - 1].variance).toBeGreaterThanOrEqual(basis[i].variance);
      }
    },
    { timeout: LLM_TIMEOUT },
  );
});
