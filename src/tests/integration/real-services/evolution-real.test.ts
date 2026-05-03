/**
 * Evolution Layer — Real-Service Integration Tests (§4.2)
 *
 * Full LLM + Memgraph integration tests for evolution modules.
 * All tests are `todo`-gated to prevent CI failures on CPU-only machines.
 *
 * To run manually:
 *   EVOLUTION_REAL_TESTS=1 bun test src/tests/integration/real-services/evolution-real.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  checkServiceHealth,
  createRealContext,
  cleanupTestData,
  LLM_TIMEOUT,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import type { WorkflowContext } from "../../../core/WorkflowContext.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";

const RUN_REAL_TESTS = process.env.EVOLUTION_REAL_TESTS === "1";

describe("Evolution Layer (real services)", () => {
  let ctx: WorkflowContext;
  let mg: MemgraphClient;

  beforeAll(async () => {
    if (!RUN_REAL_TESTS) return;
    const health = await checkServiceHealth();
    if (!health.memgraph) throw new Error("Memgraph not available");
    ctx = await createRealContext();
    mg = ctx.memgraph;
  });

  afterAll(async () => {
    if (!RUN_REAL_TESTS) return;
    // Clean up test data
    try {
      await mg.query(`MATCH (n) WHERE n.id STARTS WITH '__evo_test__' DETACH DELETE n`);
    } catch { /* best-effort */ }
    await ctx?.shutdown();
  });

  // -----------------------------------------------------------------------
  // HarnessEvolver retrospective
  // -----------------------------------------------------------------------

  it.todo(
    "HarnessEvolver retrospective — create → evolve → retrospective validates outcome " +
    "(slow on CPU — requires LLM + Memgraph)",
  );

  // -----------------------------------------------------------------------
  // SkillInjector with real embeddings
  // -----------------------------------------------------------------------

  it.todo(
    "SkillInjector with real skills — pre-populate :Skill nodes with embeddings, " +
    "verify relevant skills are injected by similarity (slow on CPU — requires embedding model)",
  );

  // -----------------------------------------------------------------------
  // IntentCompiler validation
  // -----------------------------------------------------------------------

  it.todo(
    "IntentCompiler validation — real LLM generates parseable workflow JSON " +
    "(slow on CPU — requires LLM model)",
  );

  // -----------------------------------------------------------------------
  // Full pipeline E2E
  // -----------------------------------------------------------------------

  it.todo(
    "Full pipeline E2E — run self-improving-research.json example workflow end-to-end " +
    "(slow on CPU — requires all services, 10+ min)",
  );

  // -----------------------------------------------------------------------
  // SkillBasisExtractor with ml-pca
  // -----------------------------------------------------------------------

  it.todo(
    "SkillBasisExtractor with ml-pca — provide >10 experience entries with embeddings, " +
    "verify PCA axes are returned (requires ml-pca optional dependency)",
  );
});
