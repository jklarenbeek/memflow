/**
 * HarnessEvolverModule — persistent, versioned prediction harness
 *
 * Inspired by Milkyway (2604.15719): maintain a prediction harness that
 * evolves via internal feedback (temporal contrasts) and retrospective
 * validation against real outcomes.
 *
 * Multi-modal operation:
 *  - Create:        New harness for a topic (no existing harness found)
 *  - Evolve:        Generate InternalFeedback via temporal contrast
 *  - Retrospective: Validate harness update against real outcome
 *  - Inject:        Retrieve validated harnesses for context augmentation
 *
 * Reads:  query, predictionHarness, outcomeResolution
 * Writes: predictionHarness, internalFeedback
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Maximum harness versions to retain per topic */
  maxVersions: z.number().default(10),
  /** Require retrospective validation before cross-topic transfer */
  requireRetrospective: z.boolean().default(true),
  /** LLM model override for feedback generation */
  feedbackModel: z.string().optional(),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class HarnessEvolverModule implements BaseModule<Config> {
  readonly name = "HarnessEvolver";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    const ctx = context as WorkflowContext;
    try {
      await ctx.memgraph.query(`CREATE INDEX ON :PredictionHarness(id)`);
      await ctx.memgraph.query(`CREATE INDEX ON :PredictionHarness(topicId)`);
    } catch {
      ctx.logger.debug("HarnessEvolver: Index creation skipped (may already exist)");
    }
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    const query = input.data.query;
    const harnessRequest = input.data.predictionHarness;
    const outcomeData = input.data.outcomeResolution as
      | { pendingId: string; result: { outcome: string; summary: string } }
      | undefined;

    // Mode 4: Inject — retrieve validated harnesses for context
    if (harnessRequest === "__request__") {
      const harnesses = await this.getValidatedHarnesses(ctx);
      return {
        data: { predictionHarness: undefined, internalFeedback: harnesses },
        metrics: { mode: "inject" },
      };
    }

    // Mode 3: Retrospective — validate against real outcome
    if (outcomeData && typeof harnessRequest === "object" && harnessRequest?.id) {
      const result = await this.retrospectiveCheck(ctx, config, harnessRequest, outcomeData.result);
      return {
        data: {
          predictionHarness: result.validated
            ? { ...harnessRequest, retrospectiveValidated: true }
            : undefined,
          internalFeedback: result.validated
            ? "Harness validated against outcome"
            : `Harness rolled back: ${result.correctedHarness ?? "validation failed"}`,
        },
        metrics: { mode: "retrospective", validated: result.validated },
      };
    }

    if (!query) {
      return { data: {}, metrics: { mode: "noop" } };
    }

    // Check for existing harness on this topic
    const topicId = this.computeTopicId(query);
    const existing = await this.getLatestHarness(ctx, topicId);

    if (!existing) {
      // Mode 1: Create — new harness
      const harness = await this.createHarness(ctx, config, query, topicId);
      return {
        data: {
          predictionHarness: harness,
        },
        metrics: { mode: "create", topicId },
      };
    }

    // Mode 2: Evolve — generate internal feedback and provisional update
    const evolved = await this.evolveHarness(ctx, config, existing, query);
    return {
      data: {
        predictionHarness: evolved.harness,
        internalFeedback: evolved.feedback,
      },
      metrics: { mode: "evolve", topicId, version: evolved.harness.version },
    };
  }

  // -----------------------------------------------------------------------
  // Mode 1: Create
  // -----------------------------------------------------------------------

  private async createHarness(
    ctx: WorkflowContext,
    _config: Config,
    query: string,
    topicId: string,
  ): Promise<{ id: string; content: string; version: number; topicId: string }> {
    const llm = ctx.getLLM(this.config.feedbackModel ? { llmModel: this.config.feedbackModel } : undefined);

    let content: string;
    try {
      const prompt = loadAndRender("harness/harness_init", { query, topicId });
      const resp = await llm.invoke(
        prompt.messages.map((m) => ({ type: m.role as "system" | "user", content: m.content })),
      );
      content = typeof resp.content === "string" ? resp.content : `Harness for: ${query}`;
    } catch {
      content = `Initial prediction harness for topic: ${query}`;
    }

    const id = `harness-${uuidv4()}`;
    const harness = { id, content, version: 1, topicId };

    // Persist to Memgraph
    try {
      await ctx.memgraph.query(
        `CREATE (h:PredictionHarness {
           id: $id, topicId: $topicId, version: 1,
           content: $content, status: 'active',
           createdAt: $timestamp, updatedAt: $timestamp,
           retrospectiveValidated: false
         })`,
        { id, topicId, content, timestamp: new Date().toISOString() },
      );
    } catch (err) {
      ctx.logger.warn(`HarnessEvolver: Failed to persist harness: ${(err as Error).message}`);
    }

    ctx.logger.info(`HarnessEvolver: Created harness ${id} for topic ${topicId}`);
    return harness;
  }

  // -----------------------------------------------------------------------
  // Mode 2: Evolve
  // -----------------------------------------------------------------------

  private async evolveHarness(
    ctx: WorkflowContext,
    config: Config,
    existing: { id: string; content: string; version: number; topicId: string },
    newQuery: string,
  ): Promise<{ harness: { id: string; content: string; version: number; topicId: string }; feedback: string }> {
    // Generate internal feedback via temporal contrast
    const feedback = await this.generateInternalFeedback(ctx, existing.content, newQuery);

    // Create new version
    const newId = `harness-${uuidv4()}`;
    const newVersion = existing.version + 1;

    const llm = ctx.getLLM(this.config.feedbackModel ? { llmModel: this.config.feedbackModel } : undefined);
    let newContent: string;
    try {
      const resp = await llm.invoke([
        { type: "system" as const, content: "Update the prediction harness based on the internal feedback. Preserve valuable insights and incorporate new learnings." },
        { type: "user" as const, content: `Current harness:\n${existing.content}\n\nInternal feedback:\n${feedback}\n\nNew observation:\n${newQuery}\n\nProvide the updated harness.` },
      ]);
      newContent = typeof resp.content === "string" ? resp.content : existing.content;
    } catch {
      newContent = existing.content;
    }

    const newHarness = { id: newId, content: newContent, version: newVersion, topicId: existing.topicId };

    // Persist and link versions
    try {
      await ctx.memgraph.query(
        `CREATE (h:PredictionHarness {
           id: $newId, topicId: $topicId, version: $version,
           content: $content, status: 'provisional',
           createdAt: $timestamp, updatedAt: $timestamp,
           retrospectiveValidated: false
         })`,
        {
          newId, topicId: existing.topicId, version: newVersion,
          content: newContent, timestamp: new Date().toISOString(),
        },
      );

      // Link version chain
      await ctx.memgraph.query(
        `MATCH (new:PredictionHarness {id: $newId})
         MATCH (old:PredictionHarness {id: $oldId})
         CREATE (new)-[:VERSION_OF]->(old)`,
        { newId, oldId: existing.id },
      );

      // Prune old versions if needed
      await this.pruneVersions(ctx, config, existing.topicId);
    } catch (err) {
      ctx.logger.warn(`HarnessEvolver: Failed to persist evolved harness: ${(err as Error).message}`);
    }

    ctx.logger.info(`HarnessEvolver: Evolved harness v${newVersion} for topic ${existing.topicId}`);
    return { harness: newHarness, feedback };
  }

  // -----------------------------------------------------------------------
  // Internal feedback (Milkyway §3.2)
  // -----------------------------------------------------------------------

  private async generateInternalFeedback(
    ctx: WorkflowContext,
    previousHarness: string,
    newObservation: string,
  ): Promise<string> {
    const llm = ctx.getLLM(this.config.feedbackModel ? { llmModel: this.config.feedbackModel } : undefined);

    try {
      const prompt = loadAndRender("harness/internal_feedback", {
        previousHarness,
        newObservation,
      });
      const resp = await llm.invoke(
        prompt.messages.map((m) => ({ type: m.role as "system" | "user", content: m.content })),
      );
      return typeof resp.content === "string" ? resp.content : "";
    } catch {
      return "Unable to generate internal feedback";
    }
  }

  // -----------------------------------------------------------------------
  // Mode 3: Retrospective (Milkyway §3.3)
  // -----------------------------------------------------------------------

  private async retrospectiveCheck(
    ctx: WorkflowContext,
    _config: Config,
    harness: { id: string; content: string; version: number; topicId: string },
    outcome: { outcome: string; summary: string },
  ): Promise<{ validated: boolean; correctedHarness?: string }> {
    const llm = ctx.getLLM(this.config.feedbackModel ? { llmModel: this.config.feedbackModel } : undefined);

    try {
      const prompt = loadAndRender("harness/retrospective_check", {
        harness: harness.content,
        outcome: JSON.stringify(outcome),
      });
      const resp = await llm.invoke(
        prompt.messages.map((m) => ({ type: m.role as "system" | "user", content: m.content })),
      );
      const text = typeof resp.content === "string" ? resp.content : "";
      const validated = text.toLowerCase().includes("validated");

      if (validated) {
        // Mark harness as validated
        await ctx.memgraph.query(
          `MATCH (h:PredictionHarness {id: $id})
           SET h.retrospectiveValidated = true, h.status = 'validated',
               h.updatedAt = $timestamp`,
          { id: harness.id, timestamp: new Date().toISOString() },
        );
      }

      return { validated, correctedHarness: validated ? undefined : text };
    } catch {
      return { validated: false, correctedHarness: "Retrospective check failed" };
    }
  }

  // -----------------------------------------------------------------------
  // Mode 4: Inject
  // -----------------------------------------------------------------------

  private async getValidatedHarnesses(ctx: WorkflowContext): Promise<string> {
    try {
      const harnesses = await ctx.memgraph.query<{ content: string; topicId: string; version: number }>(`
        MATCH (h:PredictionHarness)
        WHERE h.retrospectiveValidated = true AND h.status = 'validated'
        RETURN h.content AS content, h.topicId AS topicId, h.version AS version
        ORDER BY h.updatedAt DESC
        LIMIT 5
      `);

      if (harnesses.length === 0) return "";

      return harnesses
        .map((h) => `[Topic: ${h.topicId} v${h.version}]\n${h.content}`)
        .join("\n---\n");
    } catch {
      return "";
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private computeTopicId(query: string): string {
    // Simple hash-based topic ID from query
    return query.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50);
  }

  private async getLatestHarness(
    ctx: WorkflowContext,
    topicId: string,
  ): Promise<{ id: string; content: string; version: number; topicId: string } | null> {
    try {
      const results = await ctx.memgraph.query<{
        id: string; content: string; version: number; topicId: string;
      }>(`
        MATCH (h:PredictionHarness {topicId: $topicId})
        RETURN h.id AS id, h.content AS content, h.version AS version, h.topicId AS topicId
        ORDER BY h.version DESC
        LIMIT 1
      `, { topicId });

      return results[0] ?? null;
    } catch {
      return null;
    }
  }

  private async pruneVersions(ctx: WorkflowContext, config: Config, topicId: string): Promise<void> {
    try {
      await ctx.memgraph.query(`
        MATCH (h:PredictionHarness {topicId: $topicId})
        WITH h ORDER BY h.version DESC
        SKIP $maxVersions
        DETACH DELETE h
      `, { topicId, maxVersions: config.maxVersions });
    } catch {
      // Non-critical: pruning is best-effort
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return true;
  }
}
