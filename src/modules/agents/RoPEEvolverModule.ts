/**
 * RoPEEvolverModule — Role-aware Prompt Evolution (HERA §3.4)
 *
 * Reads:  trajectory, evolvedRolePrompts
 * Writes: evolvedRolePrompts (Record<string, string>)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, AgentTrajectory } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  failureThreshold: z.number().default(0.4),
  rolePrompts: z.record(z.string()).default({}),
});
type RoPEConfig = z.infer<typeof ConfigSchema>;

export class RoPEEvolverModule implements BaseModule<RoPEConfig> {
  readonly name = "RoPEEvolver";
  readonly version = "0.2.0";
  private config: RoPEConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<RoPEConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;
    const currentPrompts = (input.data.evolvedRolePrompts as Record<string, string>) ?? {};

    if (!trajectory || trajectory.reward >= this.config.failureThreshold) {
      return { data: { evolvedRolePrompts: currentPrompts }, metrics: { evolved: 0 } };
    }

    const errorSteps = trajectory.steps.filter((s) => s.action === "error");
    const weakAgent = errorSteps.length > 0
      ? errorSteps[0].agent
      : trajectory.steps.reduce((w, s) => (s.result.length < w.result.length ? s : w), trajectory.steps[0]).agent;

    try {
      const llm = ctx.getLLM();
      const currentPrompt = currentPrompts[weakAgent] ?? this.config.rolePrompts[weakAgent] ?? `You are ${weakAgent}.`;
      const weakStep = trajectory.steps.find((s) => s.agent === weakAgent);

      const resp = await llm.invoke(
        loadAndRender("hera/rope_evolution", {
          agent_role: weakAgent,
          current_prompt: currentPrompt,
          recent_failures: weakStep ? `Action: ${weakStep.action}, Result: ${weakStep.result.substring(0, 200)}` : "",
        }).messages,
      );

      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      const evolved = { ...currentPrompts };
      if (parsed.evolvedPrompt) {
        evolved[weakAgent] = parsed.evolvedPrompt;
        ctx.logger.info(`RoPEEvolver: Evolved prompt for "${weakAgent}"`);
      }
      return { data: { evolvedRolePrompts: evolved }, metrics: { evolved: 1, agent: weakAgent } };
    } catch {
      return { data: { evolvedRolePrompts: currentPrompts }, metrics: { evolved: 0 } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
