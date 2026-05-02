/**
 * HERAOrchestratorModule — backward-compatible wrapper
 *
 * Delegates to the hera-orchestration sub-workflow:
 *   PlanGenerator → TrajectoryExecutor → RewardComputer → ExperienceReflector
 *   → [RoPEEvolver] → [TopologyMutator] → FinalSynthesizer
 *
 * Retains cross-invocation state management:
 *  - Experience library (persisted across calls within a workflow run)
 *  - Previous trajectories for GRPO comparison
 *  - Evolved role prompts (RoPE paper §3.4)
 *  - Consecutive failure counter for topology mutation triggering
 *  - Persisted topology mutations for future plan generation
 *
 * All algorithmic logic (plan generation, trajectory execution, reward
 * computation, reflection, RoPE, topology mutation, synthesis) is fully
 * delegated to the atomic modules via the sub-workflow.
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
import { SubWorkflowModule } from "../core/SubWorkflowModule.js";
import { PatternRegistry } from "../../gmpl/PatternRegistry.js";

// ---------------------------------------------------------------------------
// Config — preserves original API surface
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
  /** GMPL pattern selection mode: fixed (default) or hera_adaptive (opt-in) */
  patternSelection: z.enum(["fixed", "hera_adaptive"]).default("fixed"),
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
  readonly version = "0.5.0";
  private config: HERAConfig;
  private subWorkflow: SubWorkflowModule;

  /** Experience library — persists across calls within a workflow run */
  private experienceLibrary: ExperienceEntry[] = [];
  /** Previous trajectories for GRPO comparison */
  private previousTrajectories: AgentTrajectory[] = [];
  /** RoPE: evolved role prompts per agent (paper §3.4) */
  private evolvedRolePrompts: Record<string, string> = {};
  /** Topology mutation: consecutive failure counter */
  private consecutiveFailures = 0;
  /** Topology mutation: persisted structural changes for next plan */
  private mutatedTopology: { addAgents: string[]; removeAgents: string[] } = {
    addAgents: [],
    removeAgents: [],
  };
  /** Per-agent failure buffer — tracks recent failures per agent (HERA §3.4.1) */
  private agentFailureBuffers: Record<string, Array<{ query: string; action: string; result: string }>> = {};

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/hera-orchestration.json",
      inputMap: {
        query: "query",
        retrievalResult: "retrievalResult",
        experienceLibrary: "experienceLibrary",
        previousTrajectories: "previousTrajectories",
        evolvedRolePrompts: "evolvedRolePrompts",
        consecutiveFailures: "consecutiveFailures",
        mutatedTopology: "mutatedTopology",
      },
      outputMap: {
        finalAnswer: "finalAnswer",
        trajectory: "trajectory",
        insights: "insights",
        experienceLibrary: "experienceLibrary",
        evolvedRolePrompts: "evolvedRolePrompts",
        consecutiveFailures: "consecutiveFailures",
        mutatedTopology: "mutatedTopology",
      },
    });
  }

  async init(context: unknown): Promise<void> {
    // No-op — child engine shares parent context
  }

  async process(
    input: ModuleInput<HERAConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;
    const query = (input.data.query as string) ?? "";

    ctx?.logger.info(
      `HERA: Delegating orchestration to hera-orchestration sub-workflow`,
    );

    // GMPL adaptive pattern selection (opt-in)
    let selectedPattern: string | undefined;
    if (this.config.patternSelection === "hera_adaptive") {
      selectedPattern = await this.selectPattern(ctx, query);
      ctx?.logger.info(`HERA: Adaptive pattern selection → ${selectedPattern ?? "none"}`);
    }

    // Inject persisted state into sub-workflow input
    const stageOverrides = this.buildStageConfigs();

    const result = await this.subWorkflow.process(
      {
        data: {
          ...input.data,
          experienceLibrary: this.experienceLibrary,
          previousTrajectories: this.previousTrajectories.slice(-3),
          evolvedRolePrompts: this.evolvedRolePrompts,
          consecutiveFailures: this.consecutiveFailures,
          mutatedTopology: this.mutatedTopology,
          agentFailureBuffers: this.agentFailureBuffers,
          _stageConfigs: stageOverrides,
          ...(selectedPattern && { selectedPattern }),
        },
        config: {},
      },
      context,
    );

    // Persist state from sub-workflow output
    const trajectory = result.data.trajectory as AgentTrajectory | undefined;
    const finalAnswer = (result.data.finalAnswer as string) ?? "";
    const insights = (result.data.insights as string[]) ?? [];

    if (result.data.experienceLibrary) {
      this.experienceLibrary = result.data.experienceLibrary as ExperienceEntry[];
    }
    if (result.data.evolvedRolePrompts) {
      this.evolvedRolePrompts = result.data.evolvedRolePrompts as Record<string, string>;
    }
    if (result.data.consecutiveFailures !== undefined) {
      this.consecutiveFailures = result.data.consecutiveFailures as number;
    } else if (trajectory) {
      // Track consecutive failures locally
      if (trajectory.reward < this.config.ropeFailureThreshold) {
        this.consecutiveFailures++;
      } else {
        this.consecutiveFailures = 0;
      }
    }
    if (result.data.mutatedTopology) {
      this.mutatedTopology = result.data.mutatedTopology as typeof this.mutatedTopology;
    }

    if (trajectory) {
      trajectory.finalAnswer = finalAnswer;
      trajectory.insights = insights;
      this.previousTrajectories.push(trajectory);

      // Update per-agent failure buffers (HERA §3.4.1)
      if (trajectory.reward < this.config.ropeFailureThreshold) {
        for (const step of trajectory.steps) {
          if (!this.agentFailureBuffers[step.agent]) {
            this.agentFailureBuffers[step.agent] = [];
          }
          this.agentFailureBuffers[step.agent].push({
            query: trajectory.query.substring(0, 200),
            action: step.action,
            result: step.result.substring(0, 300),
          });
          // Keep buffer bounded per agent (last 10 failures)
          if (this.agentFailureBuffers[step.agent].length > 10) {
            this.agentFailureBuffers[step.agent] =
              this.agentFailureBuffers[step.agent].slice(-10);
          }
        }
      }
    }

    return {
      data: {
        agentResult: { answer: finalAnswer, trajectory: trajectory ?? { plan: { agents: [], order: "sequential" }, steps: [], reward: 0, query: "", finalAnswer: "", insights: [] }, insights },
        finalAnswer,
      },
      metrics: {
        agents: trajectory?.plan?.agents?.length ?? 0,
        experienceSize: this.experienceLibrary.length,
        trajectorySteps: trajectory?.steps?.length ?? 0,
        evolvedPrompts: Object.keys(this.evolvedRolePrompts).length,
        consecutiveFailures: this.consecutiveFailures,
        delegated: true,
      },
    };
  }

  private buildStageConfigs(): Record<string, Record<string, unknown>> {
    return {
      plan: {
        maxAgents: this.config.maxAgents,
        availableRoles: Object.keys(this.config.rolePrompts),
      },
      execute: {
        rolePrompts: this.config.rolePrompts,
      },
      reflect: {
        experienceLibrarySize: this.config.experienceLibrarySize,
        enabled: this.config.enableEvolution,
      },
      rope_evolve: {
        failureThreshold: this.config.ropeFailureThreshold,
        enabled: this.config.enableRoPE,
      },
      topology_mutate: {
        mutationTriggerCount: this.config.mutationTriggerCount,
        enabled: this.config.enableTopologyMutation,
      },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }

  // -----------------------------------------------------------------------
  // GMPL Adaptive Pattern Selection (Phase 2)
  // -----------------------------------------------------------------------

  private async selectPattern(
    ctx: WorkflowContext | undefined,
    query: string,
  ): Promise<string | undefined> {
    if (!ctx) return undefined;

    try {
      const llm = ctx.getLLM();
      const availablePatterns = PatternRegistry.getInstance().getAll();

      if (availablePatterns.length === 0) return undefined;

      const patternDescriptions = availablePatterns
        .map((p) => `- ${p.id}: ${p.description}`)
        .join("\n");

      // Check experience library for pattern performance history
      const patternExperiences = this.experienceLibrary
        .filter((e) => e.context.startsWith("pattern-"))
        .slice(-10)
        .map((e) => `  ${e.context}: ${e.insight} (utility: ${e.utility})`)
        .join("\n");

      const prompt = [
        {
          type: "system" as const,
          content:
            "You are a meta-orchestrator selecting the optimal GMPL pattern for a query. " +
            'Respond with JSON: {"pattern": "pattern_id", "reason": "..."} or {"pattern": null} if no pattern fits.',
        },
        {
          type: "user" as const,
          content:
            `Query: ${query.substring(0, 500)}\n\n` +
            `Available patterns:\n${patternDescriptions}\n` +
            (patternExperiences
              ? `\nPast pattern performance:\n${patternExperiences}\n`
              : "") +
            `\nSelect the best pattern for this query.`,
        },
      ];

      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(
        text.match(/\{[\s\S]*\}/)?.[0] ?? "{}",
      ) as Record<string, unknown>;

      const patternId = parsed.pattern as string | null;
      if (patternId && PatternRegistry.getInstance().has(patternId)) {
        // Log selection to experience library for future learning
        this.experienceLibrary.push({
          context: `pattern-selection`,
          insight: `Selected ${patternId} for query type: ${(parsed.reason as string) ?? "no reason"}`,
          utility: 0.5,
        });
        return patternId;
      }
    } catch (err) {
      ctx.logger.warn(
        `HERA: Pattern selection failed: ${(err as Error).message}`,
      );
    }

    return undefined;
  }
}