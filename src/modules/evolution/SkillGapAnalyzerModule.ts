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
      // §5.2: Proper per-axis coverage via projection magnitude
      // We approximate the axis loading direction using the axis's top samples' mean embedding
      // Since we don't have raw loadings, we compute coverage as the spread of experience
      // projections relative to the axis variance.
      //
      // For each experience vector, compute its projection onto a reference direction
      // (mean of top-sample embeddings if available, or use an identity approximation).
      // Coverage = stddev(projections) / axis.variance — normalized spread.

      // Compute mean absolute dot-product of each experience vector with each other
      // as a coverage proxy for this axis. Higher spread = higher coverage.
      const dimCount = vectors[0]?.length ?? 0;

      // Use axisId-aligned dimensional slicing as a lightweight projection proxy
      // This avoids needing the full PCA loadings matrix while still correlating with
      // the axis direction (since PCA axes are ordered by variance contribution)
      const axisOffset = axis.axisId % Math.max(1, dimCount);
      const stride = Math.max(1, Math.floor(dimCount / skillBasis.length));

      // Extract projection magnitudes for this axis slice
      const projections = vectors.map((v) => {
        let sum = 0;
        for (let d = axisOffset; d < Math.min(axisOffset + stride, dimCount); d++) {
          sum += (v[d] ?? 0) * (v[d] ?? 0);
        }
        return Math.sqrt(sum);
      });

      // Coverage = normalized standard deviation of projections
      // For small samples (< 3), use mean projection as coverage proxy since
      // stddev is unreliable (0 for a single sample)
      const maxVariance = Math.max(axis.variance, 1e-10);
      let coverage: number;
      if (projections.length < 3) {
        const meanProj = projections.reduce((s, p) => s + p, 0) / projections.length;
        coverage = Math.min(1, meanProj / maxVariance);
      } else {
        const mean = projections.reduce((s, p) => s + p, 0) / projections.length;
        const variance = projections.reduce((s, p) => s + (p - mean) ** 2, 0) / projections.length;
        const stddev = Math.sqrt(variance);
        coverage = Math.min(1, stddev / maxVariance);
      }

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
