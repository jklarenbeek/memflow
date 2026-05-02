/**
 * OutcomeMemoryModule — two-phase outcome memory
 *
 * Extends the existing OutcomeLearnerModule with a full two-phase lifecycle:
 *   Phase 1: Log pending proposal → KG (:PendingDecision)
 *   Phase 2: Resolve with real-world outcome → KG (:Decision + :Reflection)
 *   Injection: Pull recent decisions + reflections for context augmentation
 *
 * Reads:  pendingDecision, outcomeResolution, outcomeReport
 * Writes: pendingDecision, outcomeResolution, outcomeContext
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import type { PendingDecision, OutcomeResult } from "../types.js";

const ConfigSchema = z.object({
  twoPhaseEnabled: z.boolean().default(true),
  pendingTTL: z.string().default("30d"),
  reflectionModel: z.string().optional(),
  crossDomainLessons: z.boolean().default(false),
  pruneResolved: z.object({
    maxEntries: z.number().default(500),
    strategy: z.enum(["oldest_by_entity", "lowest_confidence"]).default("oldest_by_entity"),
  }).default({}),
});
type Config = z.infer<typeof ConfigSchema>;

export class OutcomeMemoryModule implements BaseModule<Config> {
  readonly name = "OutcomeMemory";
  readonly version = "0.5.1";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    const ctx = context as WorkflowContext;
    try {
      // Lazily ensure KG schema for outcome memory nodes
      await ctx.memgraph.query(
        `CREATE INDEX ON :PendingDecision(id)`,
      );
      await ctx.memgraph.query(
        `CREATE INDEX ON :Decision(pendingId)`,
      );
      await ctx.memgraph.query(
        `CREATE INDEX ON :Reflection(decisionId)`,
      );
    } catch {
      ctx.logger.debug("OutcomeMemory: Index creation skipped (may already exist)");
    }
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    // Determine mode based on what data is present
    const pendingData = input.data.pendingDecision as PendingDecision | undefined;
    const outcomeData = input.data.outcomeResolution as { pendingId: string; result: OutcomeResult } | undefined;
    const wantsContext = input.data.outcomeContext === "__request__";

    // Mode 1: Log a pending proposal
    if (pendingData) {
      await this.logPendingProposal(ctx, pendingData);
      return {
        data: { pendingDecision: pendingData },
        metrics: { mode: "log_pending", pendingId: pendingData.id },
      };
    }

    // Mode 2: Resolve with outcome
    if (outcomeData) {
      const reflection = await this.resolveWithOutcome(ctx, outcomeData.pendingId, outcomeData.result);
      return {
        data: { outcomeResolution: { pendingId: outcomeData.pendingId, reflection } },
        metrics: { mode: "resolve", pendingId: outcomeData.pendingId },
      };
    }

    // Mode 3: Get augmented context
    if (wantsContext) {
      const augmentedContext = await this.getOutcomeAugmentedContext(ctx);
      return {
        data: { outcomeContext: augmentedContext },
        metrics: { mode: "inject", contextLength: augmentedContext.length },
      };
    }

    return { data: {}, metrics: { mode: "noop" } };
  }

  // -----------------------------------------------------------------------
  // Phase 1: Log pending proposal
  // -----------------------------------------------------------------------

  private async logPendingProposal(ctx: WorkflowContext, pending: PendingDecision): Promise<void> {
    const id = pending.id || `pending-${uuidv4()}`;

    try {
      await ctx.memgraph.query(
        `CREATE (p:PendingDecision {
           id: $id, patternId: $patternId, domainId: $domainId,
           content: $content, timestamp: $timestamp,
           resolveBefore: $resolveBefore, status: 'pending'
         })`,
        {
          id,
          patternId: pending.patternId,
          domainId: pending.domainId ?? "",
          content: pending.content,
          timestamp: pending.timestamp,
          resolveBefore: pending.resolveBefore ?? "",
        },
      );

      // Link to entities
      for (const entityId of pending.entityIds) {
        await ctx.memgraph.query(
          `MATCH (p:PendingDecision {id: $pendingId})
           MATCH (e:Entity {id: $entityId})
           MERGE (p)-[:REFERENCES]->(e)`,
          { pendingId: id, entityId },
        );
      }

      ctx.logger.info(`OutcomeMemory: Logged pending decision ${id}`);
    } catch (err) {
      ctx.logger.warn(`OutcomeMemory: Failed to log pending: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: Resolve with outcome
  // -----------------------------------------------------------------------

  private async resolveWithOutcome(ctx: WorkflowContext, pendingId: string, result: OutcomeResult): Promise<string> {
    try {
      // Fetch pending decision
      const pending = await ctx.memgraph.query<{ content: string }>(
        `MATCH (p:PendingDecision {id: $id}) RETURN p.content AS content`,
        { id: pendingId },
      );

      if (pending.length === 0) {
        ctx.logger.warn(`OutcomeMemory: Pending decision ${pendingId} not found`);
        return "";
      }

      // Apply confidence adjustment via OutcomeLearner pattern
      const adjustment = result.outcome === "success" ? 0.15 : result.outcome === "failure" ? -0.25 : 0.05;
      await ctx.memgraph.query(
        `MATCH (p:PendingDecision {id: $id})
         SET p.status = 'resolved', p.resolvedAt = $timestamp`,
        { id: pendingId, timestamp: new Date().toISOString() },
      );

      // Generate reflection via LLM
      const reflection = await this.generateReflection(ctx, pending[0].content, result);

      // Store decision + reflection in KG
      const decisionId = `decision-${uuidv4()}`;
      const reflectionId = `reflection-${uuidv4()}`;

      await ctx.memgraph.query(
        `CREATE (d:Decision {
           id: $decisionId, pendingId: $pendingId,
           content: $content, outcome: $outcome,
           summary: $summary, resolvedAt: $timestamp
         })
         CREATE (r:Reflection {
           id: $reflectionId, decisionId: $decisionId,
           content: $reflection, confidenceAdjustment: $adjustment,
           timestamp: $timestamp
         })
         CREATE (d)-[:IMPROVED_BY]->(r)`,
        {
          decisionId,
          pendingId,
          content: pending[0].content,
          outcome: result.outcome,
          summary: result.summary,
          timestamp: new Date().toISOString(),
          reflectionId,
          reflection,
          adjustment,
        },
      );

      ctx.logger.info(`OutcomeMemory: Resolved ${pendingId} → ${result.outcome}`);
      return reflection;
    } catch (err) {
      ctx.logger.warn(`OutcomeMemory: Resolution failed: ${(err as Error).message}`);
      return "";
    }
  }

  private async generateReflection(ctx: WorkflowContext, decision: string, result: OutcomeResult): Promise<string> {
    const llm = ctx.getLLM(this.config.reflectionModel ? { llmModel: this.config.reflectionModel } : undefined);

    try {
      const resp = await llm.invoke([
        { type: "system" as const, content: "Generate a brief reflection on this decision outcome. What was learned? What should be done differently?" },
        { type: "user" as const, content: `Decision: ${decision}\nOutcome: ${result.outcome}\nDetails: ${result.summary}` },
      ]);
      return typeof resp.content === "string" ? resp.content : "No reflection generated";
    } catch {
      return `Outcome: ${result.outcome}. ${result.summary}`;
    }
  }

  // -----------------------------------------------------------------------
  // Context injection
  // -----------------------------------------------------------------------

  private async getOutcomeAugmentedContext(ctx: WorkflowContext): Promise<string> {
    try {
      const decisions = await ctx.memgraph.query<{ content: string; outcome: string; reflection: string }>(
        `MATCH (d:Decision)-[:IMPROVED_BY]->(r:Reflection)
         RETURN d.content AS content, d.outcome AS outcome, r.content AS reflection
         ORDER BY d.resolvedAt DESC
         LIMIT 10`,
      );

      if (decisions.length === 0) return "";

      return decisions
        .map((d) => `[${d.outcome}] ${d.content}\nLesson: ${d.reflection}`)
        .join("\n---\n");
    } catch {
      return "";
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
