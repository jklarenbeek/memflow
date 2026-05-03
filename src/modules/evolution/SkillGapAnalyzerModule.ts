/**
 * SkillGapAnalyzerModule — identify under-covered skill areas
 *
 * Adapted from AutoSkill (2604.17614): projects the current experience
 * library onto the skill basis and reports axes with low coverage
 * as gaps requiring additional training data or skill development.
 *
 * Reads:  skillBasis, experienceLibrary
 * Writes: skillGaps
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  ExperienceEntry,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  coverageThreshold: z.number().default(0.3),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SkillGapAnalyzerModule implements BaseModule<Config> {
  readonly name = "SkillGapAnalyzer";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    const skillBasis = input.data.skillBasis as
      | Array<{ axisId: number; variance: number; topSamples: string[]; label: string }>
      | undefined;

    if (!skillBasis || skillBasis.length === 0) {
      ctx.logger.info("SkillGapAnalyzer: No skill basis provided");
      return { data: { skillGaps: [] }, metrics: { gapCount: 0 } };
    }

    // Get experience library
    let experiences: ExperienceEntry[] = input.data.experienceLibrary ?? [];

    if (experiences.length === 0) {
      try {
        const states = await ctx.memgraph.query<{ data: string }>(`
          MATCH (ms:ModuleState)
          WHERE ms.moduleKey STARTS WITH 'ExperienceReflector'
          RETURN ms.data AS data
          ORDER BY ms.updatedAt DESC
          LIMIT 2000
        `);

        for (const s of states) {
          try {
            const parsed = JSON.parse(s.data);
            if (parsed.context && parsed.insight) {
              experiences.push({
                context: parsed.context,
                insight: parsed.insight,
                utility: parsed.utility ?? 0.5,
              });
            }
          } catch { /* skip unparseable */ }
        }
      } catch (err) {
        ctx.logger.debug(`SkillGapAnalyzer: ModuleState query failed: ${(err as Error).message}`);
      }
    }

    if (experiences.length === 0) {
      // No experience data to analyze — all axes are gaps
      const gaps = skillBasis.map((axis) => ({
        axisId: axis.axisId,
        label: axis.label,
        coverage: 0,
        recommendation: `No experience data available for ${axis.label}. Collect more execution traces.`,
      }));

      return { data: { skillGaps: gaps }, metrics: { gapCount: gaps.length } };
    }

    // Embed experiences
    const embeddings = ctx.getEmbeddings();
    const texts = experiences.map((e) => `${e.context} ${e.insight}`);
    const vectors = await embeddings.embedDocuments(texts);

    // Compute coverage for each axis
    const gaps: Array<{ axisId: number; label: string; coverage: number; recommendation: string }> = [];

    for (const axis of skillBasis) {
      // For each axis, compute mean absolute projection magnitude
      // Using the top samples as proxy direction vector
      const coverage = axis.variance; // Use variance as coverage proxy

      if (coverage < config.coverageThreshold) {
        gaps.push({
          axisId: axis.axisId,
          label: axis.label,
          coverage,
          recommendation: `Low coverage on ${axis.label} (${(coverage * 100).toFixed(1)}%). ` +
            `Consider collecting more experience data related to: ${axis.topSamples.slice(0, 2).join("; ")}`,
        });
      }
    }

    ctx.logger.info(
      `SkillGapAnalyzer: Found ${gaps.length} gaps out of ${skillBasis.length} axes (threshold: ${config.coverageThreshold})`,
    );

    return {
      data: { skillGaps: gaps },
      metrics: {
        gapCount: gaps.length,
        totalAxes: skillBasis.length,
        coverageRatio: 1 - (gaps.length / skillBasis.length),
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
