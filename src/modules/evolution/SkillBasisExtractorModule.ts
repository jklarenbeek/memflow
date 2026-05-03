/**
 * SkillBasisExtractorModule — embedding-space PCA for skill characterization
 *
 * Adapted from AutoSkill (2604.17614): uses PCA on embedding vectors
 * (not activation-space — a weaker but practical signal) to identify
 * orthogonal skill basis directions.
 *
 * Requires `ml-matrix` optional dependency.
 *
 * Reads:  experienceLibrary (or queries from Memgraph)
 * Writes: skillBasis
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
  maxTrajectories: z.number().default(2000),
  numComponents: z.number().default(10),
  topKSamplesPerAxis: z.number().default(5),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SkillBasisExtractorModule implements BaseModule<Config> {
  readonly name = "SkillBasisExtractor";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    // Get experience library
    let experiences: ExperienceEntry[] = input.data.experienceLibrary ?? [];

    if (experiences.length === 0) {
      try {
        const states = await ctx.memgraph.query<{ data: string }>(`
          MATCH (ms:ModuleState)
          WHERE ms.moduleKey STARTS WITH 'ExperienceReflector'
          RETURN ms.data AS data
          ORDER BY ms.updatedAt DESC
          LIMIT $limit
        `, { limit: config.maxTrajectories });

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
        ctx.logger.debug(`SkillBasisExtractor: ModuleState query failed: ${(err as Error).message}`);
      }
    }

    if (experiences.length < config.numComponents + 1) {
      ctx.logger.info(
        `SkillBasisExtractor: Not enough experiences (${experiences.length}) for ${config.numComponents} components`,
      );
      return { data: { skillBasis: [] }, metrics: { axisCount: 0 } };
    }

    // Down-sample if needed
    if (experiences.length > config.maxTrajectories) {
      experiences = experiences.slice(0, config.maxTrajectories);
    }

    // Embed experiences
    const embeddings = ctx.getEmbeddings();
    const texts = experiences.map((e) => `${e.context} ${e.insight}`);
    const vectors = await embeddings.embedDocuments(texts);

    // Run PCA via ml-matrix
    let basis: Array<{ axisId: number; variance: number; topSamples: string[]; label: string }>;

    try {
      basis = await this.runPCA(vectors, texts, experiences, config);
    } catch (err) {
      ctx.logger.warn(`SkillBasisExtractor: PCA failed (is ml-matrix installed?): ${(err as Error).message}`);
      return { data: { skillBasis: [] }, metrics: { axisCount: 0, error: 1 } };
    }

    ctx.logger.info(`SkillBasisExtractor: Extracted ${basis.length} basis axes`);

    return {
      data: { skillBasis: basis },
      metrics: {
        axisCount: basis.length,
        totalVarianceExplained: basis.reduce((sum, b) => sum + b.variance, 0),
      },
    };
  }

  // -----------------------------------------------------------------------
  // PCA
  // -----------------------------------------------------------------------

  private async runPCA(
    vectors: number[][],
    texts: string[],
    experiences: ExperienceEntry[],
    config: Config,
  ): Promise<Array<{ axisId: number; variance: number; topSamples: string[]; label: string }>> {
    // Dynamic import of ml-pca (optional dependency)
    let PCA: any;
    try {
      const mlPca = await import("ml-pca" as string);
      PCA = mlPca.PCA;
    } catch {
      throw new Error(
        "SkillBasisExtractor requires the 'ml-pca' package for PCA analysis. " +
        "Install it with: bun add ml-pca",
      );
    }

    const pca = new PCA(vectors);
    const eigenvalues = pca.getEigenvalues();
    const loadings = pca.getLoadings();

    const totalVar = eigenvalues.reduce((s: number, v: number) => s + v, 0);
    const effectiveComponents = Math.min(config.numComponents, eigenvalues.length);

    const basis: Array<{ axisId: number; variance: number; topSamples: string[]; label: string }> = [];

    for (let c = 0; c < effectiveComponents; c++) {
      const varianceExplained = totalVar > 0 ? eigenvalues[c] / totalVar : 0;

      // Project each sample onto this axis
      const projections = vectors.map((v) => {
        let dot = 0;
        for (let d = 0; d < v.length && d < loadings[c]?.length; d++) {
          dot += v[d] * (loadings[c][d] ?? 0);
        }
        return Math.abs(dot);
      });

      // Find top-K samples with highest projection magnitude
      const indexed = projections.map((p, i) => ({ projection: p, index: i }));
      indexed.sort((a, b) => b.projection - a.projection);
      const topSamples = indexed
        .slice(0, config.topKSamplesPerAxis)
        .map((s) => texts[s.index].substring(0, 100));

      // Generate a simple label from the top samples
      const label = `Axis ${c + 1} (${(varianceExplained * 100).toFixed(1)}% var)`;

      basis.push({
        axisId: c,
        variance: varianceExplained,
        topSamples,
        label,
      });
    }

    return basis;
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
