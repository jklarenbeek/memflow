/**
 * RewardComputerModule — composite reward scoring for trajectories
 *
 * Extracted from HERA. Computes a [0,1] reward from multiple signals:
 * retrieval quality, step success rate, answer completeness, efficiency.
 * Used by downstream modules (ExperienceReflector, RoPEEvolver) for
 * GRPO-style group comparison.
 *
 * Reads:  trajectory (AgentTrajectory)
 * Writes: trajectory (enriched with computed reward)
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  AgentTrajectory,
  RetrievalResult,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Weight for retrieval quality signal */
  retrievalWeight: z.number().default(0.3),
  /** Weight for step success rate */
  successWeight: z.number().default(0.25),
  /** Weight for answer completeness */
  completenessWeight: z.number().default(0.25),
  /** Weight for efficiency */
  efficiencyWeight: z.number().default(0.2),
});

type RewardConfig = z.infer<typeof ConfigSchema>;

export class RewardComputerModule implements BaseModule<RewardConfig> {
  readonly name = "RewardComputer";
  readonly version = "0.5.0";
  private config: RewardConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<RewardConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;

    if (!trajectory) {
      return { data: {}, metrics: { reward: 0 } };
    }

    const steps = trajectory.steps;
    const retrievalScore = retrieval?.score ?? 0.3;
    const successfulSteps = steps.filter((s) => s.action !== "error").length;
    const stepSuccessRate = steps.length > 0 ? successfulSteps / steps.length : 0;
    const finalAnswer = steps.at(-1)?.result ?? "";
    const completenessScore = Math.min(1, finalAnswer.length / 500);
    const totalChars = steps.reduce((acc, s) => acc + (s.result?.length ?? 0), 0);
    const efficiencyScore = 1 / Math.max(1, Math.ceil(totalChars / 4) / 1000);

    const reward = Math.max(0, Math.min(1,
      retrievalScore * this.config.retrievalWeight +
      stepSuccessRate * this.config.successWeight +
      completenessScore * this.config.completenessWeight +
      efficiencyScore * this.config.efficiencyWeight,
    ));

    trajectory.reward = reward;

    ctx.logger.debug(`RewardComputer: reward=${reward.toFixed(3)}`);

    return {
      data: { trajectory },
      metrics: { reward: Number(reward.toFixed(3)), retrievalScore, stepSuccessRate },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
