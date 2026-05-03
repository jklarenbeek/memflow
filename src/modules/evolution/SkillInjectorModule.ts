/**
 * SkillInjectorModule — retrieve relevant skills and inject into system prompt context
 *
 * Inspired by Trace2Skill (2603.25158): closes the loop by making distilled
 * skills available at inference-time to downstream modules.
 *
 * Configurable `global` / `selective` mode determines which modules receive
 * skill context. Skills are retrieved from Memgraph :Skill nodes by vector
 * similarity against the current query.
 *
 * Reads:  query
 * Writes: injectedSkills
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";
import { evolutionSkillInjectionsCounter } from "../../server/metrics.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  mode: z.enum(["global", "selective"]).default("selective"),
  /** When mode = "selective", only inject before these module types */
  targetModules: z.array(z.string()).default([
    "PlanGenerator", "AnswerGenerator", "DebateModule",
    "ParallelDispatcher", "FinalSynthesizer",
  ]),
  maxSkills: z.number().min(1).max(10).default(3),
  minSimilarity: z.number().min(0).max(1).default(0.65),
  /** If true, log injected skills to WorkflowData for traceability */
  traceInjections: z.boolean().default(true),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SkillInjectorModule implements BaseModule<Config> {
  readonly name = "SkillInjector";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;
    const query = input.data.query;

    if (!query) {
      ctx.logger.debug("SkillInjector: No query provided, skipping injection");
      return { data: {}, metrics: { injectedCount: 0 } };
    }

    // Embed the current query
    const embeddings = ctx.getEmbeddings();
    let queryVector: number[];
    try {
      queryVector = await embeddings.embedQuery(query);
    } catch (err) {
      ctx.logger.warn(`SkillInjector: Query embedding failed: ${(err as Error).message}`);
      return { data: {}, metrics: { injectedCount: 0 } };
    }

    // Retrieve skill nodes from Memgraph
    let skills: Array<{
      id: string; name: string; description: string;
      applicableWhen: string; doPatterns: string[];
      dontPatterns: string[]; embedding: number[];
    }> = [];

    try {
      skills = await ctx.memgraph.query<{
        id: string; name: string; description: string;
        applicableWhen: string; doPatterns: string[];
        dontPatterns: string[]; embedding: number[];
      }>(`
        MATCH (s:Skill)
        WHERE s.embedding IS NOT NULL
        RETURN s.id AS id, s.name AS name, s.description AS description,
               s.applicableWhen AS applicableWhen,
               s.doPatterns AS doPatterns, s.dontPatterns AS dontPatterns,
               s.embedding AS embedding
      `);
    } catch (err) {
      ctx.logger.debug(`SkillInjector: Skill query failed: ${(err as Error).message}`);
      return { data: {}, metrics: { injectedCount: 0 } };
    }

    if (skills.length === 0) {
      ctx.logger.debug("SkillInjector: No skills found in graph");
      return { data: {}, metrics: { injectedCount: 0 } };
    }

    // Score skills by similarity to query
    const scored = skills
      .map((s) => ({
        ...s,
        similarity: cosineSimilarity(queryVector, s.embedding),
      }))
      .filter((s) => s.similarity >= config.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, config.maxSkills);

    if (scored.length === 0) {
      ctx.logger.debug("SkillInjector: No skills above similarity threshold");
      return { data: {}, metrics: { injectedCount: 0 } };
    }

    // Format skills as injection context
    const injectionBlocks = scored.map((s) => {
      const doStr = s.doPatterns?.length > 0 ? `\n  DO: ${s.doPatterns.join("; ")}` : "";
      const dontStr = s.dontPatterns?.length > 0 ? `\n  DON'T: ${s.dontPatterns.join("; ")}` : "";
      return `[Skill: ${s.name}] ${s.description}\n  When: ${s.applicableWhen}${doStr}${dontStr}`;
    });

    const injectedSkills = config.traceInjections
      ? scored.map((s) => `${s.name} (sim: ${s.similarity.toFixed(3)})`)
      : undefined;

    ctx.logger.info(
      `SkillInjector: Injected ${scored.length} skills (mode: ${config.mode}): ${scored.map((s) => s.name).join(", ")}`,
    );

    // §8: Record Prometheus metrics
    evolutionSkillInjectionsCounter.inc(scored.length);

    return {
      data: {
        injectedSkills: injectedSkills,
        // Store the formatted context block for downstream modules
        skillContext: injectionBlocks.join("\n---\n"),
      },
      metrics: {
        injectedCount: scored.length,
        avgSimilarity: scored.reduce((sum, s) => sum + s.similarity, 0) / scored.length,
      },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
