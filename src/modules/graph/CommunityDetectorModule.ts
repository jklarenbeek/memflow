/**
 * CommunityDetectorModule — MAGE Leiden community detection
 * Reads:  (graph state)
 * Writes: (side-effect: community labels on Entity nodes)
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({ maxIterations: z.number().default(10) });
type Config = z.infer<typeof ConfigSchema>;

export class CommunityDetectorModule implements BaseModule<Config> {
  readonly name = "CommunityDetector";
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    try {
      await ctx.memgraph.query(
        `CALL mage.community_leiden("Entity", "RELATES_TO", {max_iterations: ${this.config.maxIterations}}) YIELD *`,
      );
      ctx.logger.info("CommunityDetector: Leiden algorithm completed");
      return { data: {}, metrics: { detected: true } };
    } catch {
      ctx.logger.debug("CommunityDetector: MAGE not available");
      return { data: {}, metrics: { detected: false } };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
