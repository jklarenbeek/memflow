/**
 * HERAOrchestratorModule — real multi-agent orchestration
 *
 * Adapted from HRW's HERAOrchestrator (160 lines). Implements:
 *
 *  1. Experience Library: Profile-Insight-Utility tuples that persist
 *     across queries, reinforced by GRPO-style group comparison
 *  2. LLM-generated agent topologies: dynamically selects agents
 *     (retriever, reasoner, critic, synthesizer) per query
 *  3. Multi-agent trajectory execution with accumulated context
 *  4. Reflection & evolution: compares trajectories, extracts insights,
 *     prunes low-utility experience entries
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  AgentTrajectory,
  AgentPlan,
  AgentStep,
  ExperienceEntry,
  RetrievalResult,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender, loadRolePrompt } from "../../utils/promptLoader.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  maxAgents: z.number().default(4),
  enableEvolution: z.boolean().default(true),
  experienceLibrarySize: z.number().default(50),
  /** Enable Role-aware Prompt Evolution (paper §3.4) */
  enableRoPE: z.boolean().default(true),
  /** Reward threshold below which an agent is considered underperforming */
  ropeFailureThreshold: z.number().default(0.4),
  /** Enable topology mutation (paper §3.5) */
  enableTopologyMutation: z.boolean().default(true),
  /** Reward threshold for triggering topology mutation */
  mutationThreshold: z.number().default(0.3),
  /** Number of consecutive failures before topology mutation triggers */
  mutationTriggerCount: z.number().default(3),
  rolePrompts: z
    .record(z.string())
    .default({
      retriever:
        "You are a precise evidence retriever. Use tools to gather relevant chunks and memories.",
      reasoner:
        "You are a logical reasoner. Synthesize evidence into coherent answer with citations.",
      critic:
        "You are a critic. Identify gaps, hallucinations, or inconsistencies in the draft.",
      synthesizer:
        "You are a final synthesizer. Produce the polished, cited response.",
      verifier:
        "You are a fact verifier. Cross-check claims against evidence and flag unsupported statements.",
      decomposer:
        "You are a query decomposer. Break complex questions into simpler sub-queries.",
    }),
});

type HERAConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class HERAOrchestratorModule implements BaseModule<HERAConfig> {
  readonly name = "HERAOrchestrator";
  readonly version = "0.2.0";
  private config: HERAConfig;
  private ctx?: WorkflowContext;

  /** Experience library — persists across calls within a workflow run */
  private experienceLibrary: ExperienceEntry[] = [];
  /** Previous trajectories for GRPO comparison */
  private previousTrajectories: AgentTrajectory[] = [];
  /** RoPE: evolved role prompts per agent (paper §3.4) */
  private evolvedRolePrompts: Map<string, string> = new Map();
  /** RoPE: per-agent failed trajectory buffer */
  private failedTrajectoryBuffer: Map<string, AgentTrajectory[]> = new Map();
  /** Topology mutation: consecutive failure counter */
  private consecutiveFailures = 0;
  /** Topology mutation: persisted structural changes for next plan */
  private mutatedTopology: { addAgents: string[]; removeAgents: string[] } = {
    addAgents: [],
    removeAgents: [],
  };

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<HERAConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const query = (input.data.query as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;

    ctx.logger.info(
      `HERA: Orchestrating for query "${query.substring(0, 60)}…"`,
    );

    // 1. Generate query-specific agent topology
    const plan = await this.generatePlan(query, retrieval, ctx);

    // 2. Execute multi-agent trajectory
    const trajectory = await this.executeTrajectory(
      query,
      plan,
      retrieval,
      ctx,
    );

    // 3. Reflect & evolve experience library
    const insights = await this.reflectAndEvolve(trajectory, ctx);

    // 4. RoPE: Role-aware Prompt Evolution (paper §3.4)
    if (this.config.enableRoPE && trajectory.reward < this.config.ropeFailureThreshold) {
      await this.evolveAgentPrompts(trajectory, ctx);
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 0;
    }

    // 5. Topology mutation (paper §3.5)
    if (
      this.config.enableTopologyMutation &&
      this.consecutiveFailures >= this.config.mutationTriggerCount
    ) {
      await this.mutateTopology(trajectory, ctx);
      this.consecutiveFailures = 0;
    }

    // 6. Final synthesis
    const finalAnswer = await this.synthesizeFinal(trajectory, ctx);

    trajectory.finalAnswer = finalAnswer;
    trajectory.insights = insights;
    this.previousTrajectories.push(trajectory);

    return {
      data: {
        agentResult: { answer: finalAnswer, trajectory, insights },
        finalAnswer,
      },
      metrics: {
        agents: plan.agents.length,
        experienceSize: this.experienceLibrary.length,
        trajectorySteps: trajectory.steps.length,
        evolvedPrompts: this.evolvedRolePrompts.size,
        consecutiveFailures: this.consecutiveFailures,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Plan generation
  // -----------------------------------------------------------------------

  private async generatePlan(
    query: string,
    retrieval: RetrievalResult | undefined,
    ctx: WorkflowContext,
  ): Promise<AgentPlan> {
    const relevantExp = this.experienceLibrary
      .filter((e) => e.utility > 0.6)
      .sort((a, b) => b.utility - a.utility)
      .slice(0, 5)
      .map((e) => e.insight)
      .join("\n");

    const prompt = loadAndRender("hera/plan_generation", {
      query,
      evidence_summary: retrieval ? `${retrieval.chunks.length} chunks, score ${retrieval.score.toFixed(2)}` : "none yet",
      insights: relevantExp || "none",
      available_roles: Object.keys(this.config.rolePrompts).join(", "),
    });

    try {
      const llm = ctx.getLLM();
      const resp = await llm.invoke(prompt.messages);
      const text =
        typeof resp.content === "string"
          ? resp.content
          : JSON.stringify(resp.content);
      const parsed = JSON.parse(
        text.match(/\{[\s\S]*\}/)?.[0] ?? "{}",
      );
      return {
        agents: parsed.agents ?? ["retriever", "reasoner"],
        order: parsed.order ?? "sequential",
        dependencies: parsed.dependencies,
        tokenBudget: parsed.tokenBudget ?? 6000,
      };
    } catch {
      // Apply any persisted topology mutations
      let agents = ["retriever", "reasoner", "synthesizer"];
      if (this.mutatedTopology.addAgents.length > 0) {
        agents = [...agents, ...this.mutatedTopology.addAgents];
      }
      agents = agents.filter((a) => !this.mutatedTopology.removeAgents.includes(a));
      return {
        agents,
        order: "sequential",
        tokenBudget: 6000,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Trajectory execution
  // -----------------------------------------------------------------------

  private async executeTrajectory(
    query: string,
    plan: AgentPlan,
    retrieval: RetrievalResult | undefined,
    ctx: WorkflowContext,
  ): Promise<AgentTrajectory> {
    const steps: AgentStep[] = [];
    let contextSoFar = retrieval
      ? `Evidence: ${retrieval.chunks
          .map((c) => c.pageContent.substring(0, 300))
          .join("\n---\n")}`
      : "";

    const llm = ctx.getLLM();

    for (const role of plan.agents) {
      // RoPE: prefer evolved prompts, then TOML roles, then config defaults (paper §3.4)
      const rolePrompt =
        this.evolvedRolePrompts.get(role) ??
        loadRolePrompt(role) ??
        this.config.rolePrompts[role] ??
        `You are ${role}.`;
      const fullPrompt = `${rolePrompt}\n\nQuery: ${query}\n\nCurrent context: ${contextSoFar}\n\nRespond with your output.`;

      const startTime = Date.now();
      try {
        const response = await llm.invoke([
          { role: "user", content: fullPrompt },
        ]);
        const output =
          typeof response.content === "string"
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

    // Compute reward from multi-signal evaluation (GRPO-style):
    // downstream task quality + efficiency (token usage)
    const reward = this.computeReward(steps, retrieval);

    return {
      query,
      plan,
      steps,
      finalAnswer: steps.at(-1)?.result ?? "No answer generated",
      reward,
      insights: [],
    };
  }

  // -----------------------------------------------------------------------
  // Reward computation (GRPO-style multi-signal evaluation)
  // -----------------------------------------------------------------------

  /**
   * Compute a composite reward for a trajectory.
   *
   * Per the HERA paper (arXiv:2604.00901), trajectories are ranked by:
   *  1. Downstream task performance (retrieval score, answer completeness)
   *  2. Efficiency (total token usage across all agents)
   *
   * Returns a score in [0, 1] used by reflectAndEvolve() for GRPO-style
   * group comparison and experience library updates.
   */
  private computeReward(
    steps: AgentStep[],
    retrieval: RetrievalResult | undefined,
  ): number {
    // Signal 1: Retrieval quality (0–1)
    const retrievalScore = retrieval?.score ?? 0.3;

    // Signal 2: Step success rate — fraction of steps that didn't error
    const successfulSteps = steps.filter((s) => s.action !== "error").length;
    const stepSuccessRate = steps.length > 0 ? successfulSteps / steps.length : 0;

    // Signal 3: Answer completeness — longer, substantive answers score higher
    const finalAnswer = steps.at(-1)?.result ?? "";
    const answerLength = finalAnswer.length;
    const completenessScore = Math.min(1, answerLength / 500); // saturates at 500 chars

    // Signal 4: Efficiency — penalise excessive token usage
    // Estimate total tokens from all step results + prompts
    const totalChars = steps.reduce((acc, s) => acc + (s.result?.length ?? 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    const efficiencyScore = 1 / Math.max(1, estimatedTokens / 1000);

    // Composite: weighted combination (paper uses performance > efficiency)
    const reward =
      retrievalScore * 0.3 +
      stepSuccessRate * 0.25 +
      completenessScore * 0.25 +
      efficiencyScore * 0.2;

    return Math.max(0, Math.min(1, reward));
  }

  // -----------------------------------------------------------------------
  // GRPO-style reflection & experience evolution
  // -----------------------------------------------------------------------

  private async reflectAndEvolve(
    current: AgentTrajectory,
    ctx: WorkflowContext,
  ): Promise<string[]> {
    if (!this.config.enableEvolution) {
      return ["Evolution disabled"];
    }

    // GRPO-style group comparison when prior trajectories exist;
    // self-reflection on the very first call to bootstrap the experience library
    const hasPrior = this.previousTrajectories.length > 0;
    const group = hasPrior
      ? [current, ...this.previousTrajectories.slice(-3)]
      : [current];
    const ranked = group.sort((a, b) => b.reward - a.reward);

    try {
      const llm = ctx.getLLM();
      const prompt = hasPrior
        ? loadAndRender("hera/reflection", {
            trajectories: JSON.stringify(ranked.map((t, i) => ({ rank: i + 1, reward: t.reward, agents: t.plan.agents, steps: t.steps.length }))),
          })
        : loadAndRender("hera/reflection_single", {
            trajectory: JSON.stringify({ reward: current.reward, agents: current.plan.agents, steps: current.steps.map((s) => ({ agent: s.agent, action: s.action })) }),
          });

      const resp = await llm.invoke(prompt.messages);
      const insightText =
        typeof resp.content === "string" ? resp.content : "";
      const insights =
        insightText.match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [
          insightText.substring(0, 200),
        ];

      // Update experience library
      for (const insight of insights.slice(0, 3)) {
        const existing = this.experienceLibrary.find((e) =>
          e.insight.includes(insight.substring(0, 30)),
        );
        if (existing) {
          existing.utility = Math.min(1, existing.utility + 0.1);
        } else {
          this.experienceLibrary.push({
            context: current.query.substring(0, 40),
            insight,
            utility: 0.7,
          });
        }
      }

      // Prune low-utility entries
      this.experienceLibrary = this.experienceLibrary
        .filter((e) => e.utility > 0.4)
        .sort((a, b) => b.utility - a.utility)
        .slice(0, this.config.experienceLibrarySize);

      current.insights = insights;
      return insights;
    } catch {
      return ["Reflection failed"];
    }
  }

  // -----------------------------------------------------------------------
  // Final synthesis
  // -----------------------------------------------------------------------

  private async synthesizeFinal(
    trajectory: AgentTrajectory,
    ctx: WorkflowContext,
  ): Promise<string> {
    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("hera/synthesis", {
        query: trajectory.query,
        steps: trajectory.steps.map((s) => `${s.agent}: ${s.result.substring(0, 400)}`).join("\n\n"),
      });

      const resp = await llm.invoke(messages);
      return typeof resp.content === "string"
        ? resp.content
        : "Synthesis failed";
    } catch {
      return trajectory.finalAnswer;
    }
  }

  // -----------------------------------------------------------------------
  // RoPE: Role-aware Prompt Evolution (paper §3.4)
  // -----------------------------------------------------------------------

  /**
   * Evolve underperforming agent prompts via contrastive analysis.
   *
   * Per HERA paper §3.4:
   * 1. Buffer the failed trajectory per-agent
   * 2. Identify the primary contributor to failure
   * 3. Generate prompt variants and extract:
   *    - Operational rules (Δρ_op): short-term corrective behaviors
   *    - Behavioral principles (Δρ_bp): long-term strategies
   * 4. Consolidate updates into the agent's evolved prompt
   */
  private async evolveAgentPrompts(
    trajectory: AgentTrajectory,
    ctx: WorkflowContext,
  ): Promise<void> {
    // Identify the weakest agent (error or shortest useful output)
    const errorSteps = trajectory.steps.filter((s) => s.action === "error");
    const weakAgent = errorSteps.length > 0
      ? errorSteps[0].agent
      : trajectory.steps.reduce(
          (worst, s) => (s.result.length < worst.result.length ? s : worst),
          trajectory.steps[0],
        ).agent;

    // Buffer failed trajectory for this agent
    const buffer = this.failedTrajectoryBuffer.get(weakAgent) ?? [];
    buffer.push(trajectory);
    this.failedTrajectoryBuffer.set(weakAgent, buffer.slice(-5));

    try {
      const llm = ctx.getLLM();
      const currentPrompt =
        this.evolvedRolePrompts.get(weakAgent) ??
        this.config.rolePrompts[weakAgent] ??
        `You are ${weakAgent}.`;

      const recentFailures = buffer
        .slice(-3)
        .map((t) => {
          const step = t.steps.find((s) => s.agent === weakAgent);
          return step ? `Action: ${step.action}, Result: ${step.result.substring(0, 200)}` : "";
        })
        .filter(Boolean)
        .join("\n");

      const resp = await llm.invoke(
        loadAndRender("hera/rope_evolution", {
          agent_role: weakAgent,
          current_prompt: currentPrompt,
          recent_failures: recentFailures,
        }).messages,
      );

      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      if (parsed.evolvedPrompt) {
        // Prompt consolidation: integrate updates while maintaining coherence
        this.evolvedRolePrompts.set(weakAgent, parsed.evolvedPrompt);
        ctx.logger.info(
          `HERA RoPE: Evolved prompt for "${weakAgent}" with ${parsed.operationalRules?.length ?? 0} rules + ${parsed.behavioralPrinciples?.length ?? 0} principles`,
        );
      }
    } catch {
      ctx.logger.debug("RoPE prompt evolution failed, keeping current prompt");
    }
  }

  // -----------------------------------------------------------------------
  // Topology Mutation (paper §3.5)
  // -----------------------------------------------------------------------

  /**
   * Mutate the agent topology when trajectories consistently fail.
   *
   * Per HERA paper §3.5: when persistent failures indicate structural
   * deficiencies, replace failing agents or augment the topology
   * with additional agents.
   */
  private async mutateTopology(
    trajectory: AgentTrajectory,
    ctx: WorkflowContext,
  ): Promise<void> {
    try {
      const llm = ctx.getLLM();
      const availableRoles = Object.keys(this.config.rolePrompts);
      const currentRoles = trajectory.plan.agents;
      const unusedRoles = availableRoles.filter((r) => !currentRoles.includes(r));

      const resp = await llm.invoke(
        loadAndRender("hera/topology_mutation", {
          current_roles: currentRoles.join(", "),
          failure_count: this.consecutiveFailures,
          unused_roles: unusedRoles.join(", "),
          reward: trajectory.reward.toFixed(3),
        }).messages,
      );

      const text = typeof resp.content === "string" ? resp.content : "";
      const mutation = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      if (mutation.action === "replace" && mutation.removeAgent && mutation.addAgent) {
        // Persist topology mutation structurally for future plans
        this.mutatedTopology.removeAgents.push(mutation.removeAgent);
        this.mutatedTopology.addAgents.push(mutation.addAgent);
        ctx.logger.info(
          `HERA Topology: Replacing "${mutation.removeAgent}" with "${mutation.addAgent}" — ${mutation.reason}`,
        );
        // Store insight about this mutation
        this.experienceLibrary.push({
          context: `topology-mutation`,
          insight: `Replace ${mutation.removeAgent} with ${mutation.addAgent}: ${mutation.reason}`,
          utility: 0.8,
        });
      } else if (mutation.action === "augment" && mutation.addAgent) {
        // Persist augmentation
        this.mutatedTopology.addAgents.push(mutation.addAgent);
        ctx.logger.info(
          `HERA Topology: Augmenting with "${mutation.addAgent}" — ${mutation.reason}`,
        );
        this.experienceLibrary.push({
          context: `topology-augment`,
          insight: `Add ${mutation.addAgent} to topology: ${mutation.reason}`,
          utility: 0.8,
        });
      }
    } catch {
      ctx.logger.debug("Topology mutation analysis failed");
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}