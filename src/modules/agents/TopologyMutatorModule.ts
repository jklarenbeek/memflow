/**
 * TopologyMutatorModule — structural topology changes (HERA §3.5)
 *
 * Reads:  trajectory, consecutiveFailures
 * Writes: mutatedTopology, experienceLibrary
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, AgentTrajectory, ExperienceEntry } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  mutationTriggerCount: z.number().default(3),
  availableRoles: z.array(z.string()).default(["retriever", "reasoner", "critic", "synthesizer", "verifier", "decomposer"]),
});
type MutatorConfig = z.infer<typeof ConfigSchema>;

export class TopologyMutatorModule implements BaseModule<MutatorConfig> {
  readonly name = "TopologyMutator";
  readonly version = "0.5.0";
  private config: MutatorConfig;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<MutatorConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;
    const consecutiveFailures = (input.data.consecutiveFailures as number) ?? 0;
    const currentMutations = (input.data.mutatedTopology as { addAgents: string[]; removeAgents: string[] }) ?? { addAgents: [], removeAgents: [] };
    let experienceLibrary = [...((input.data.experienceLibrary as ExperienceEntry[]) ?? [])];

    if (!trajectory || consecutiveFailures < this.config.mutationTriggerCount) {
      return { data: { mutatedTopology: currentMutations, experienceLibrary }, metrics: { mutated: 0 } };
    }

    try {
      const llm = ctx.getLLM();
      const currentRoles = trajectory.plan.agents;
      const unusedRoles = this.config.availableRoles.filter((r) => !currentRoles.includes(r));

      const resp = await llm.invoke(
        loadAndRender("hera/topology_mutation", {
          current_roles: currentRoles.join(", "),
          failure_count: consecutiveFailures,
          unused_roles: unusedRoles.join(", "),
          reward: trajectory.reward.toFixed(3),
        }).messages,
      );

      const text = typeof resp.content === "string" ? resp.content : "";
      const mutation = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      const mutations = { ...currentMutations };

      if (mutation.action === "replace" && mutation.removeAgent && mutation.addAgent) {
        mutations.removeAgents = [...mutations.removeAgents, mutation.removeAgent];
        mutations.addAgents = [...mutations.addAgents, mutation.addAgent];
        experienceLibrary.push({ context: "topology-mutation", insight: `Replace ${mutation.removeAgent} with ${mutation.addAgent}: ${mutation.reason}`, utility: 0.8 });
        ctx.logger.info(`TopologyMutator: Replacing "${mutation.removeAgent}" with "${mutation.addAgent}"`);
      } else if (mutation.action === "augment" && mutation.addAgent) {
        mutations.addAgents = [...mutations.addAgents, mutation.addAgent];
        experienceLibrary.push({ context: "topology-augment", insight: `Add ${mutation.addAgent}: ${mutation.reason}`, utility: 0.8 });
        ctx.logger.info(`TopologyMutator: Augmenting with "${mutation.addAgent}"`);
      }

      return { data: { mutatedTopology: mutations, experienceLibrary, consecutiveFailures: 0 }, metrics: { mutated: 1 } };
    } catch {
      return { data: { mutatedTopology: currentMutations, experienceLibrary }, metrics: { mutated: 0 } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
