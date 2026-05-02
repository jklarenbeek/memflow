/**
 * TrajectoryExecutorModule — multi-agent sequential execution
 *
 * Extracted from HERA. Executes a sequence of agent steps based on an
 * AgentPlan, accumulating context across steps. Each agent uses
 * evolved prompts (RoPE) when available, falling back to TOML roles.
 *
 * Reads:  query, agentPlan, retrievalResult
 * Writes: trajectory (AgentTrajectory)
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  AgentPlan,
  AgentStep,
  AgentTrajectory,
  RetrievalResult,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadRolePrompt } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Default role prompts for agents */
  rolePrompts: z
    .record(z.string())
    .default({
      retriever: "You are a precise evidence retriever. Use tools to gather relevant chunks and memories.",
      reasoner: "You are a logical reasoner. Synthesize evidence into coherent answer with citations.",
      critic: "You are a critic. Identify gaps, hallucinations, or inconsistencies in the draft.",
      synthesizer: "You are a final synthesizer. Produce the polished, cited response.",
      verifier: "You are a fact verifier. Cross-check claims against evidence and flag unsupported statements.",
      decomposer: "You are a query decomposer. Break complex questions into simpler sub-queries.",
    }),
});

type TrajectoryConfig = z.infer<typeof ConfigSchema>;

export class TrajectoryExecutorModule implements BaseModule<TrajectoryConfig> {
  readonly name = "TrajectoryExecutor";
  readonly version = "0.5.0";
  private config: TrajectoryConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<TrajectoryConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const plan = (input.data.agentPlan as AgentPlan) ?? { agents: ["reasoner"], order: "sequential" };
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;
    const evolvedPrompts = (input.data.evolvedRolePrompts as Record<string, string>) ?? {};

    const steps: AgentStep[] = [];
    let contextSoFar = retrieval
      ? `Evidence: ${retrieval.chunks.map((c) => c.pageContent.substring(0, 300)).join("\n---\n")}`
      : "";

    const llm = ctx.getLLM();

    for (const role of plan.agents) {
      // RoPE: prefer evolved prompts, then TOML roles, then config defaults
      const rolePrompt =
        evolvedPrompts[role] ??
        loadRolePrompt(role) ??
        this.config.rolePrompts[role] ??
        `You are ${role}.`;

      const fullPrompt = `${rolePrompt}\n\nQuery: ${query}\n\nCurrent context: ${contextSoFar}\n\nRespond with your output.`;
      const startTime = Date.now();

      try {
        const response = await llm.invoke([{ role: "user", content: fullPrompt }]);
        const output = typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

        steps.push({
          agent: role,
          action: "process",
          result: output.substring(0, 1200),
          durationMs: Date.now() - startTime,
        });

        contextSoFar += `\n\n[${role.toUpperCase()}]: ${output.substring(0, 600)}`;
      } catch (err) {
        steps.push({
          agent: role,
          action: "error",
          result: (err as Error).message,
          durationMs: Date.now() - startTime,
        });
      }
    }

    // Compute reward
    const reward = this.computeReward(steps, retrieval);

    const trajectory: AgentTrajectory = {
      query,
      plan,
      steps,
      finalAnswer: steps.at(-1)?.result ?? "No answer generated",
      reward,
      insights: [],
    };

    ctx.logger.info(
      `TrajectoryExecutor: ${steps.length} steps, reward=${reward.toFixed(3)}`,
    );

    return {
      data: { trajectory, finalAnswer: trajectory.finalAnswer },
      metrics: { steps: steps.length, reward: Number(reward.toFixed(3)) },
    };
  }

  private computeReward(steps: AgentStep[], retrieval: RetrievalResult | undefined): number {
    const retrievalScore = retrieval?.score ?? 0.3;
    const successfulSteps = steps.filter((s) => s.action !== "error").length;
    const stepSuccessRate = steps.length > 0 ? successfulSteps / steps.length : 0;
    const finalAnswer = steps.at(-1)?.result ?? "";
    const completenessScore = Math.min(1, finalAnswer.length / 500);
    const totalChars = steps.reduce((acc, s) => acc + (s.result?.length ?? 0), 0);
    const efficiencyScore = 1 / Math.max(1, Math.ceil(totalChars / 4) / 1000);

    return Math.max(0, Math.min(1,
      retrievalScore * 0.3 + stepSuccessRate * 0.25 +
      completenessScore * 0.25 + efficiencyScore * 0.2,
    ));
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
