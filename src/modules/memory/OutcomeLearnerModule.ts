/**
 * OutcomeLearnerModule — Karpathy Loop-style reinforcement learning for memories
 *
 * Reads outcome reports and adjusts memory weights accordingly:
 *  - Success → boost memory importance / confidence
 *  - Failure → demote or generate preventive rule
 *  - Partial → minor adjustment
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, OutcomeReport } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  successBoost: z.number().default(0.15),
  failurePenalty: z.number().default(0.25),
  partialBoost: z.number().default(0.05),
  minConfidence: z.number().default(0.1),
  maxConfidence: z.number().default(1.0),
});

type Config = z.infer<typeof ConfigSchema>;

export class OutcomeLearnerModule implements BaseModule<Config> {
  readonly name = "OutcomeLearner";
  readonly version = "0.5.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const report = input.data.outcomeReport as OutcomeReport | undefined;

    if (!report) {
      return { data: {}, metrics: { adjusted: 0 } };
    }

    const adjustment = this.computeAdjustment(report.outcome);
    let adjusted = 0;

    try {
      for (const memoryId of report.memoryIds) {
        await ctx.memgraph.query(
          `MATCH (m:MemoryUnit {id: $id})
           SET m.confidence = clamp(coalesce(m.confidence, 0.5) + $adjustment, $min, $max),
               m.lastReviewed = $timestamp`,
          {
            id: memoryId,
            adjustment,
            min: this.config.minConfidence,
            max: this.config.maxConfidence,
            timestamp: report.timestamp,
          },
        );
        adjusted++;
      }

      ctx.logger.info(`OutcomeLearner: Adjusted ${adjusted} memories for outcome=${report.outcome}`, {
        agentId: report.agentId,
        adjustment,
      });
    } catch (err) {
      ctx.logger.warn(`OutcomeLearner: Adjustment failed: ${(err as Error).message}`);
    }

    return {
      data: {},
      metrics: { adjusted, adjustment, outcome: report.outcome },
    };
  }

  private computeAdjustment(outcome: OutcomeReport["outcome"]): number {
    switch (outcome) {
      case "success": return this.config.successBoost;
      case "failure": return -this.config.failurePenalty;
      case "partial": return this.config.partialBoost;
      default: return 0;
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return true;
  }
}
