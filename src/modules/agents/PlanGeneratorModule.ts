/**
 * PlanGeneratorModule — LLM-driven agent topology generation
 *
 * Extracted from HERA. Generates a query-specific agent plan by
 * consulting the experience library and available role prompts.
 *
 * Reads:  query, retrievalResult, (experience library via StateStore)
 * Writes: agentPlan (AgentPlan)
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  RetrievalResult,
  AgentPlan,
  ExperienceEntry,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  maxAgents: z.number().default(4),
  availableRoles: z
    .array(z.string())
    .default(["retriever", "reasoner", "critic", "synthesizer", "verifier", "decomposer"]),
  /** State key for persisted experience library */
  experienceStateKey: z.string().default("hera_experience_library"),
  /** State key for persisted topology mutations */
  topologyStateKey: z.string().default("hera_topology_mutations"),
});

type PlanGeneratorConfig = z.infer<typeof ConfigSchema>;

export class PlanGeneratorModule implements BaseModule<PlanGeneratorConfig> {
  readonly name = "PlanGenerator";
  readonly version = "0.5.0";
  private config: PlanGeneratorConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<PlanGeneratorConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const query = (input.data.query as string) ?? "";
    const retrieval = input.data.retrievalResult as RetrievalResult | undefined;

    // Load experience library from state store
    const experienceLibrary =
      ((input.data.experienceLibrary as ExperienceEntry[]) ?? []);

    const relevantExp = experienceLibrary
      .filter((e) => e.utility > 0.6)
      .sort((a, b) => b.utility - a.utility)
      .slice(0, 5)
      .map((e) => e.insight)
      .join("\n");

    // Load any persisted topology mutations
    const mutatedTopology = (input.data.mutatedTopology as {
      addAgents: string[];
      removeAgents: string[];
    }) ?? { addAgents: [], removeAgents: [] };

    try {
      const llm = ctx.getLLM();
      const prompt = loadAndRender("hera/plan_generation", {
        query,
        evidence_summary: retrieval
          ? `${retrieval.chunks.length} chunks, score ${retrieval.score.toFixed(2)}`
          : "none yet",
        insights: relevantExp || "none",
        available_roles: this.config.availableRoles.join(", "),
      });

      const resp = await llm.invoke(prompt.messages);
      const text = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      const plan: AgentPlan = {
        agents: (parsed.agents ?? ["retriever", "reasoner"]).slice(0, this.config.maxAgents),
        order: parsed.order ?? "sequential",
        dependencies: parsed.dependencies,
        tokenBudget: parsed.tokenBudget ?? 6000,
      };

      ctx.logger.info(`PlanGenerator: ${plan.agents.join(" → ")}`);

      return {
        data: { agentPlan: plan },
        metrics: { agents: plan.agents.length },
      };
    } catch {
      // Apply persisted topology mutations to default plan
      let agents = ["retriever", "reasoner", "synthesizer"];
      if (mutatedTopology.addAgents.length > 0) {
        agents = [...agents, ...mutatedTopology.addAgents];
      }
      agents = agents.filter((a) => !mutatedTopology.removeAgents.includes(a));

      const plan: AgentPlan = { agents, order: "sequential", tokenBudget: 6000 };

      return {
        data: { agentPlan: plan },
        metrics: { agents: plan.agents.length, fallback: 1 },
      };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
