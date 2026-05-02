/**
 * ExperienceReflectorModule — GRPO-style reflection & experience evolution
 *
 * Extracted from HERA. Compares trajectories via group ranking,
 * extracts insights, and updates the experience library.
 *
 * Reads:  trajectory (AgentTrajectory)
 * Writes: insights (string[]), experienceLibrary (ExperienceEntry[])
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  AgentTrajectory,
  ExperienceEntry,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  experienceLibrarySize: z.number().default(50),
  /** Minimum utility to retain in the library */
  minUtility: z.number().default(0.4),
});

type ReflectorConfig = z.infer<typeof ConfigSchema>;

export class ExperienceReflectorModule implements BaseModule<ReflectorConfig> {
  readonly name = "ExperienceReflector";
  readonly version = "0.5.0";
  private config: ReflectorConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<ReflectorConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;
    const previousTrajectories = (input.data.previousTrajectories as AgentTrajectory[]) ?? [];
    let experienceLibrary = [...((input.data.experienceLibrary as ExperienceEntry[]) ?? [])];

    if (!trajectory) {
      return { data: { insights: [], experienceLibrary }, metrics: {} };
    }

    // GRPO-style: group comparison when prior trajectories exist
    const hasPrior = previousTrajectories.length > 0;
    const group = hasPrior
      ? [trajectory, ...previousTrajectories.slice(-3)]
      : [trajectory];
    const ranked = group.sort((a, b) => b.reward - a.reward);

    let insights: string[] = [];

    try {
      const llm = ctx.getLLM();
      const prompt = hasPrior
        ? loadAndRender("hera/reflection", {
            trajectories: JSON.stringify(
              ranked.map((t, i) => ({
                rank: i + 1,
                reward: t.reward,
                agents: t.plan.agents,
                steps: t.steps.length,
              })),
            ),
          })
        : loadAndRender("hera/reflection_single", {
            trajectory: JSON.stringify({
              reward: trajectory.reward,
              agents: trajectory.plan.agents,
              steps: trajectory.steps.map((s) => ({ agent: s.agent, action: s.action })),
            }),
          });

      const resp = await llm.invoke(prompt.messages);
      const insightText = typeof resp.content === "string" ? resp.content : "";
      insights = insightText.match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [
        insightText.substring(0, 200),
      ];

      // Update experience library
      for (const insight of insights.slice(0, 3)) {
        const existing = experienceLibrary.find((e) =>
          e.insight.includes(insight.substring(0, 30)),
        );
        if (existing) {
          existing.utility = Math.min(1, existing.utility + 0.1);
        } else {
          experienceLibrary.push({
            context: trajectory.query.substring(0, 40),
            insight,
            utility: 0.7,
          });
        }
      }

      // Prune low-utility entries
      experienceLibrary = experienceLibrary
        .filter((e) => e.utility > this.config.minUtility)
        .sort((a, b) => b.utility - a.utility)
        .slice(0, this.config.experienceLibrarySize);
    } catch {
      insights = ["Reflection failed"];
    }

    ctx.logger.info(
      `ExperienceReflector: ${insights.length} insights, library size: ${experienceLibrary.length}`,
    );

    return {
      data: { insights, experienceLibrary, trajectory },
      metrics: { insights: insights.length, librarySize: experienceLibrary.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
