/**
 * RoPEEvolverModule — Role-aware Prompt Evolution (HERA §3.4)
 *
 * Implements the paper's two-dimensional prompt evolution:
 *   Δρᵢ = Δρᵢᵒᵖ + Δρᵢᵇᵖ
 *
 * Where Δρᵢᵒᵖ are operational rules (short-term corrections) and
 * Δρᵢᵇᵖ are behavioral principles (long-term strategies).
 *
 * Prompt updates are CONSOLIDATED (not overwritten) via projection ΠC:
 *   ρᵢᵗ⁺¹ = ΠC(ρᵢᵗ ⊕ Δρᵢ)
 *
 * The consolidation step prunes redundant or conflicting instructions
 * and enforces a maximum prompt length for coherence.
 *
 * Reads:  trajectory, evolvedRolePrompts, agentFailureBuffers
 * Writes: evolvedRolePrompts (Record<string, string>)
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, AgentTrajectory } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  failureThreshold: z.number().default(0.4),
  rolePrompts: z.record(z.string()).default({}),
  /** Maximum prompt length (chars) for consolidation projection ΠC */
  maxPromptLength: z.number().default(2000),
});
type RoPEConfig = z.infer<typeof ConfigSchema>;

export class RoPEEvolverModule implements BaseModule<RoPEConfig> {
  readonly name = "RoPEEvolver";
  readonly version = "0.3.0";
  private config: RoPEConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<RoPEConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;
    const currentPrompts = (input.data.evolvedRolePrompts as Record<string, string>) ?? {};

    if (!trajectory || trajectory.reward >= this.config.failureThreshold) {
      return { data: { evolvedRolePrompts: currentPrompts }, metrics: { evolved: 0 } };
    }

    // Identify the weakest agent from error steps or shortest output
    const errorSteps = trajectory.steps.filter((s) => s.action === "error");
    const weakAgent = errorSteps.length > 0
      ? errorSteps[0].agent
      : trajectory.steps.reduce((w, s) => (s.result.length < w.result.length ? s : w), trajectory.steps[0]).agent;

    // Retrieve per-agent failure buffer for recurring pattern analysis
    const agentFailureBuffers = (input.data as Record<string, unknown>).agentFailureBuffers as
      Record<string, Array<{ query: string; action: string; result: string }>> | undefined;
    const failureHistory = agentFailureBuffers?.[weakAgent] ?? [];

    try {
      const llm = ctx.getLLM();
      const currentPrompt = currentPrompts[weakAgent] ?? this.config.rolePrompts[weakAgent] ?? `You are ${weakAgent}.`;
      const weakStep = trajectory.steps.find((s) => s.agent === weakAgent);

      // Build recent failure context from per-agent buffer
      const recentFailures = failureHistory.length > 0
        ? failureHistory.slice(-5).map((f, i) =>
            `[${i + 1}] Query: ${f.query.substring(0, 80)}, Action: ${f.action}, Result: ${f.result.substring(0, 150)}`
          ).join("\n")
        : weakStep
          ? `Action: ${weakStep.action}, Result: ${weakStep.result.substring(0, 200)}`
          : "";

      const resp = await llm.invoke(
        loadAndRender("hera/rope_evolution", {
          agent_role: weakAgent,
          current_prompt: currentPrompt,
          recent_failures: recentFailures,
        }).messages,
      );

      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      const evolved = { ...currentPrompts };

      if (parsed.evolvedPrompt) {
        // ΠC consolidation: merge old + new, prune redundancies, enforce length
        const consolidated = await this.consolidatePrompt(
          currentPrompt,
          parsed.evolvedPrompt,
          ctx,
        );
        evolved[weakAgent] = consolidated;
        ctx.logger.info(`RoPEEvolver: Consolidated prompt for "${weakAgent}" (${consolidated.length} chars)`);
      }
      return { data: { evolvedRolePrompts: evolved }, metrics: { evolved: 1, agent: weakAgent } };
    } catch {
      return { data: { evolvedRolePrompts: currentPrompts }, metrics: { evolved: 0 } };
    }
  }

  /**
   * Prompt Consolidation — projection ΠC (HERA §3.4.2)
   *
   * Merges the existing prompt with new evolution delta, then prunes
   * redundant or conflicting instructions to maintain a compact and
   * coherent representation within maxPromptLength.
   *
   *   ρᵢᵗ⁺¹ = ΠC(ρᵢᵗ ⊕ Δρᵢ)
   */
  private async consolidatePrompt(
    existingPrompt: string,
    newDelta: string,
    ctx: WorkflowContext,
  ): Promise<string> {
    try {
      const llm = ctx.getLLM();
      const resp = await llm.invoke([
        {
          role: "system",
          content: `You are a prompt consolidation engine. Your task is to merge an existing agent role prompt with new improvement instructions into a single, coherent, non-redundant prompt.

Rules:
1. MERGE both prompts — do NOT discard the existing prompt's core identity and instructions.
2. INTEGRATE new operational rules and behavioral principles from the delta.
3. REMOVE any redundant, conflicting, or superseded instructions (keep the newer version).
4. KEEP the result CONCISE — maximum ${this.config.maxPromptLength} characters.
5. Maintain a clear structure: identity → core behavior → operational rules → strategic principles.
6. Output ONLY the consolidated prompt text, nothing else.`,
        },
        {
          role: "user",
          content: `EXISTING PROMPT:\n${existingPrompt}\n\nNEW IMPROVEMENT DELTA:\n${newDelta}\n\nConsolidate into a single coherent prompt:`,
        },
      ]);

      const consolidated = typeof resp.content === "string" ? resp.content.trim() : "";

      if (consolidated.length > 0 && consolidated.length <= this.config.maxPromptLength) {
        return consolidated;
      }

      // If LLM output exceeds limit, truncate intelligently
      if (consolidated.length > this.config.maxPromptLength) {
        return consolidated.substring(0, this.config.maxPromptLength);
      }

      // Fallback: simple concatenation with dedup
      return this.heuristicConsolidate(existingPrompt, newDelta);
    } catch {
      return this.heuristicConsolidate(existingPrompt, newDelta);
    }
  }

  /**
   * Heuristic fallback consolidation: append new instructions that
   * don't already appear in the existing prompt, then truncate.
   */
  private heuristicConsolidate(existing: string, delta: string): string {
    const existingLower = existing.toLowerCase();
    const newSentences = delta
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10 && !existingLower.includes(s.toLowerCase().substring(0, 30)));

    const merged = newSentences.length > 0
      ? `${existing}\n\nAdditional rules:\n${newSentences.map((s) => `- ${s}`).join("\n")}`
      : existing;

    return merged.substring(0, this.config.maxPromptLength);
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
