/**
 * SkillMergeModule — hierarchical conflict-free skill consolidation
 *
 * Inspired by Trace2Skill (2603.25158): takes per-cluster analyst reports
 * and merges them into declarative, transferable skill documents.
 *
 * Reads:  traceClusters, analystReports
 * Writes: distilledSkills
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";
import { evolutionSkillsDistilledCounter } from "../../server/metrics.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  maxSkillsPerCluster: z.number().default(3),
  conflictResolution: z.enum(["llm_merge", "highest_utility"]).default("llm_merge"),
  /** Persist skills to Memgraph as :Skill nodes */
  persistToGraph: z.boolean().default(true),
  /** Also write skills as TOML files for hot-reload */
  persistToToml: z.boolean().default(false),
  tomlOutputDir: z.string().default("src/prompts/skills"),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistilledSkill {
  id: string;
  name: string;
  description: string;
  applicableWhen: string;
  doPatterns: string[];
  dontPatterns: string[];
  sourceTraceCount: number;
  version: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SkillMergeModule implements BaseModule<Config> {
  readonly name = "SkillMerge";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    const ctx = context as WorkflowContext;
    try {
      await ctx.memgraph.query(`CREATE INDEX ON :Skill(id)`);
    } catch {
      ctx.logger.debug("SkillMerge: Index creation skipped (may already exist)");
    }
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    const clusters = input.data.traceClusters as
      | Array<{ centroid: number[]; members: Array<{ context: string; insight: string; utility: number }> }>
      | undefined;

    if (!clusters || clusters.length === 0) {
      ctx.logger.info("SkillMerge: No clusters to merge");
      return { data: { distilledSkills: [] }, metrics: { skillCount: 0 } };
    }

    const skills: DistilledSkill[] = [];
    const llm = ctx.getLLM();

    for (const cluster of clusters) {
      try {
        // Gather all insights from cluster members
        const clusterInsights = cluster.members
          .map((m) => `Context: ${m.context}\nInsight: ${m.insight}`)
          .join("\n---\n");

        // Use LLM to merge insights into a declarative skill
        const prompt = loadAndRender("trace2skill/merger", {
          insights: clusterInsights,
          maxSkills: String(config.maxSkillsPerCluster),
        });

        const resp = await llm.invoke(
          prompt.messages.map((m) => ({ type: m.role as "system" | "user", content: m.content })),
        );

        const text = typeof resp.content === "string" ? resp.content : "";

        // Parse LLM response as JSON skill document(s)
        const parsed = this.parseSkillResponse(text, cluster.members.length);

        for (const skill of parsed.slice(0, config.maxSkillsPerCluster)) {
          skills.push(skill);

          // Persist to Memgraph if configured
          if (config.persistToGraph) {
            await this.persistSkillToGraph(ctx, skill, cluster.centroid);
          }
        }
      } catch (err) {
        ctx.logger.warn(`SkillMerge: Failed to merge cluster: ${(err as Error).message}`);
      }
    }

    ctx.logger.info(`SkillMerge: Distilled ${skills.length} skills from ${clusters.length} clusters`);

    // §8: Record Prometheus metrics
    if (skills.length > 0) evolutionSkillsDistilledCounter.inc(skills.length);

    return {
      data: { distilledSkills: skills },
      metrics: { skillCount: skills.length, clusterCount: clusters.length },
    };
  }

  // -----------------------------------------------------------------------
  // Parsing
  // -----------------------------------------------------------------------

  private parseSkillResponse(text: string, sourceTraceCount: number): DistilledSkill[] {
    const skills: DistilledSkill[] = [];

    try {
      // Try parsing as JSON array or single object
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        skills.push({
          id: `skill-${uuidv4()}`,
          name: item.name ?? "Unnamed Skill",
          description: item.description ?? "",
          applicableWhen: item.applicableWhen ?? item.applicable_when ?? "",
          doPatterns: Array.isArray(item.doPatterns ?? item.do_patterns)
            ? (item.doPatterns ?? item.do_patterns)
            : [],
          dontPatterns: Array.isArray(item.dontPatterns ?? item.dont_patterns)
            ? (item.dontPatterns ?? item.dont_patterns)
            : [],
          sourceTraceCount,
          version: 1,
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // If JSON parsing fails, create a single skill from the raw text
      skills.push({
        id: `skill-${uuidv4()}`,
        name: "Merged Insight",
        description: text.substring(0, 500),
        applicableWhen: "General",
        doPatterns: [],
        dontPatterns: [],
        sourceTraceCount,
        version: 1,
        createdAt: new Date().toISOString(),
      });
    }

    return skills;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private async persistSkillToGraph(
    ctx: WorkflowContext,
    skill: DistilledSkill,
    embedding: number[],
  ): Promise<void> {
    try {
      await ctx.memgraph.query(
        `CREATE (s:Skill {
           id: $id, name: $name, description: $description,
           applicableWhen: $applicableWhen,
           doPatterns: $doPatterns, dontPatterns: $dontPatterns,
           embedding: $embedding, version: $version,
           createdAt: $createdAt, sourceTraceCount: $sourceTraceCount
         })`,
        {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          applicableWhen: skill.applicableWhen,
          doPatterns: skill.doPatterns,
          dontPatterns: skill.dontPatterns,
          embedding,
          version: skill.version,
          createdAt: skill.createdAt,
          sourceTraceCount: skill.sourceTraceCount,
        },
      );
    } catch (err) {
      ctx.logger.debug(`SkillMerge: Failed to persist skill ${skill.id}: ${(err as Error).message}`);
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
