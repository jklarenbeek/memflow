/**
 * SLMDatasetExporterModule — export validated experience data as SLM training datasets
 *
 * Inspired by Memo (2604.27707): retrieval-based memory hits a generalization
 * ceiling; weight-based consolidation is the missing neocortical path.
 * SLM dataset export is the pragmatic bridge.
 *
 * Data sources (mapped to actual Memgraph schema):
 *  - Resolved decisions with reflections (:Decision/:Reflection)
 *  - Converged debate sessions (:DebateSession)
 *  - Accepted peer reviews (:ReviewSession)
 *  - Resilient red team sessions (:RedTeamSession)
 *  - Experience reflections (:ModuleState)
 *
 * Reads:  (none — standalone)
 * Writes: datasetExportPath, datasetManifest
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import {
  evolutionDatasetExportsCounter,
  evolutionDatasetSamplesCounter,
} from "../../server/metrics.js";
import { cosineSimilarity } from "../../utils/similarity.js";
import {
  formatSamples,
  toJSONL,
  generateManifest,
  type RawSample,
} from "../../utils/datasetFormatters.js";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const TriggerConfigSchema = z.object({
  type: z.enum(["on_demand", "scheduled", "event_driven"]).default("on_demand"),
  /** Cron expression for scheduled mode (reserved for future) */
  cronExpression: z.string().optional(),
  /** Outcome count threshold for event-driven mode (reserved for future) */
  outcomeThreshold: z.number().optional(),
});

const QualityFilterSchema = z.object({
  minConfidence: z.number().min(0).max(1).default(0.6),
  deduplicationThreshold: z.number().min(0).max(1).default(0.92),
  requireRetrospectiveValidation: z.boolean().default(true),
});

const ConfigSchema = z.object({
  outputDir: z.string().default("data/slm-datasets"),
  format: z.enum(["sft", "dpo", "both"]).default("both"),
  maxSamples: z.number().min(1).max(100000).default(10000),
  domainFilter: z.string().optional(),
  trigger: TriggerConfigSchema.default({ type: "on_demand" }),
  quality: QualityFilterSchema.prefault({}),
  /** Include a dataset manifest with statistics */
  includeManifest: z.boolean().default(true),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SLMDatasetExporterModule implements BaseModule<Config> {
  readonly name = "SLMDatasetExporter";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const config = input.config;

    // 1. Validate trigger mode
    if (config.trigger.type !== "on_demand") {
      ctx.logger.warn(
        `SLMDatasetExporter: trigger type '${config.trigger.type}' not yet implemented, falling back to on_demand`,
      );
    }

    // 2. Query Memgraph for each data source
    const rawSamples = await this.collectSamples(ctx, config);

    // 3. Deduplicate via embedding similarity
    const deduped = await this.deduplicateSamples(ctx, rawSamples, config.quality.deduplicationThreshold);

    // 4. Format into SFT/DPO
    const { sftSamples, dpoSamples } = formatSamples(deduped, config.format);

    // 5. Write to disk
    const exportPath = await this.writeDataset(ctx, sftSamples, dpoSamples, config);

    // 6. Generate manifest
    const manifest = config.includeManifest
      ? generateManifest(sftSamples, dpoSamples, exportPath, {
          minConfidence: config.quality.minConfidence,
          deduplicationThreshold: config.quality.deduplicationThreshold,
          retrospectiveValidation: config.quality.requireRetrospectiveValidation,
        })
      : undefined;

    // §8: Record Prometheus metrics
    evolutionDatasetExportsCounter.inc();
    if (sftSamples.length > 0) evolutionDatasetSamplesCounter.inc({ type: "sft" }, sftSamples.length);
    if (dpoSamples.length > 0) evolutionDatasetSamplesCounter.inc({ type: "dpo" }, dpoSamples.length);

    return {
      data: { datasetExportPath: exportPath, datasetManifest: manifest },
      metrics: { sftCount: sftSamples.length, dpoCount: dpoSamples.length },
    };
  }

  // -----------------------------------------------------------------------
  // Sample collection
  // -----------------------------------------------------------------------

  private async collectSamples(ctx: WorkflowContext, config: Config): Promise<RawSample[]> {
    const samples: RawSample[] = [];

    // Source 1: Resolved decisions with reflections
    try {
      const decisions = await ctx.memgraph.query<{
        content: string; outcome: string; reflection: string; domainId: string;
      }>(`
        MATCH (p:PendingDecision {status: 'resolved'})
        MATCH (d:Decision {pendingId: p.id})-[:IMPROVED_BY]->(r:Reflection)
        ${config.domainFilter ? "WHERE p.domainId = $domainFilter" : ""}
        RETURN d.content AS content, d.outcome AS outcome,
               r.content AS reflection, p.domainId AS domainId
        ORDER BY d.resolvedAt DESC
        LIMIT $limit
      `, { domainFilter: config.domainFilter, limit: config.maxSamples });

      for (const d of decisions) {
        samples.push({
          type: d.outcome === "failure" ? "negative" : "positive",
          instruction: "Analyze the following decision and provide a reflection on its outcome.",
          input: d.content,
          output: d.reflection,
          source: "decision_reflection",
          confidence: d.outcome === "success" ? 0.9 : d.outcome === "partial" ? 0.7 : 0.4,
        });
      }
    } catch (err) {
      ctx.logger.debug(`SLMDatasetExporter: Decision query failed: ${(err as Error).message}`);
    }

    // Source 2: Debate sessions (converged)
    try {
      const debates = await ctx.memgraph.query<{
        query: string; verdict: string; convergenceScore: number;
      }>(`
        MATCH (ds:DebateSession)
        WHERE ds.convergenceScore >= $minConfidence
        RETURN ds.query AS query, ds.verdict AS verdict,
               ds.convergenceScore AS convergenceScore
        ORDER BY ds.timestamp DESC
        LIMIT $limit
      `, { minConfidence: config.quality.minConfidence, limit: config.maxSamples });

      for (const d of debates) {
        samples.push({
          type: "positive",
          instruction: "Synthesize a balanced analysis of the following question, considering multiple perspectives.",
          input: d.query,
          output: d.verdict,
          source: "debate_synthesis",
          confidence: d.convergenceScore,
        });
      }
    } catch (err) {
      ctx.logger.debug(`SLMDatasetExporter: Debate query failed: ${(err as Error).message}`);
    }

    // Source 3: Accepted peer reviews
    try {
      const reviews = await ctx.memgraph.query<{
        content: string; feedback: string;
      }>(`
        MATCH (rs:ReviewSession)
        WHERE rs.accepted = true
        RETURN rs.content AS content, rs.feedback AS feedback
        ORDER BY rs.timestamp DESC
        LIMIT $limit
      `, { limit: config.maxSamples });

      for (const r of reviews) {
        samples.push({
          type: "positive",
          instruction: "Review the following content and provide constructive feedback.",
          input: r.content,
          output: r.feedback,
          source: "peer_review",
          confidence: 0.8,
        });
      }
    } catch (err) {
      ctx.logger.debug(`SLMDatasetExporter: Review query failed: ${(err as Error).message}`);
    }

    // Source 4: Resilient red team sessions
    try {
      const redTeams = await ctx.memgraph.query<{
        attack: string; defense: string; resilienceScore: number;
      }>(`
        MATCH (rt:RedTeamSession)
        WHERE rt.resilienceScore > 0.7
        RETURN rt.attack AS attack, rt.defense AS defense,
               rt.resilienceScore AS resilienceScore
        ORDER BY rt.timestamp DESC
        LIMIT $limit
      `, { limit: config.maxSamples });

      for (const rt of redTeams) {
        // Defense is the positive (chosen) response
        samples.push({
          type: "positive",
          instruction: "Defend against the following adversarial challenge.",
          input: rt.attack,
          output: rt.defense,
          source: "red_team",
          confidence: rt.resilienceScore,
        });
        // Attack is the negative (rejected) response for DPO
        samples.push({
          type: "negative",
          instruction: "Defend against the following adversarial challenge.",
          input: rt.attack,
          output: rt.attack, // Attack used as rejected
          source: "red_team",
          confidence: 1 - rt.resilienceScore,
        });
      }
    } catch (err) {
      ctx.logger.debug(`SLMDatasetExporter: RedTeam query failed: ${(err as Error).message}`);
    }

    // Source 5: Experience reflections from ModuleState
    try {
      const reflections = await ctx.memgraph.query<{
        data: string;
      }>(`
        MATCH (ms:ModuleState)
        WHERE ms.moduleKey STARTS WITH 'ExperienceReflector'
        RETURN ms.data AS data
        ORDER BY ms.updatedAt DESC
        LIMIT $limit
      `, { limit: config.maxSamples });

      for (const r of reflections) {
        try {
          const parsed = JSON.parse(r.data);
          if (parsed.insight && parsed.context) {
            samples.push({
              type: "positive",
              instruction: "Extract actionable insights from the following experience.",
              input: parsed.context,
              output: parsed.insight,
              source: "experience_reflection",
              confidence: parsed.utility ?? 0.7,
            });
          }
        } catch {
          // Skip unparseable ModuleState data
        }
      }
    } catch (err) {
      ctx.logger.debug(`SLMDatasetExporter: ModuleState query failed: ${(err as Error).message}`);
    }

    // Apply confidence filter
    const filtered = samples.filter((s) => s.confidence >= config.quality.minConfidence);
    ctx.logger.info(
      `SLMDatasetExporter: Collected ${samples.length} raw samples, ${filtered.length} after confidence filter (>= ${config.quality.minConfidence})`,
    );

    return filtered;
  }

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  private async deduplicateSamples(
    ctx: WorkflowContext,
    samples: RawSample[],
    threshold: number,
  ): Promise<RawSample[]> {
    if (samples.length === 0) return [];

    const embeddings = ctx.getEmbeddings();
    const texts = samples.map((s) => `${s.instruction} ${s.input}`);

    let vectors: number[][];
    try {
      vectors = await embeddings.embedDocuments(texts);
    } catch (err) {
      ctx.logger.warn(`SLMDatasetExporter: Embedding failed, skipping dedup: ${(err as Error).message}`);
      return samples;
    }

    // Greedy deduplication: keep first occurrence, skip near-duplicates
    const kept: RawSample[] = [];
    const keptVectors: number[][] = [];

    for (let i = 0; i < samples.length; i++) {
      const isDuplicate = keptVectors.some(
        (kv) => cosineSimilarity(kv, vectors[i]) >= threshold,
      );
      if (!isDuplicate) {
        kept.push(samples[i]);
        keptVectors.push(vectors[i]);
      }
    }

    ctx.logger.info(
      `SLMDatasetExporter: ${samples.length} → ${kept.length} after dedup (threshold: ${threshold})`,
    );
    return kept;
  }

  // -----------------------------------------------------------------------
  // Write to disk
  // -----------------------------------------------------------------------

  private async writeDataset(
    ctx: WorkflowContext,
    sftSamples: { instruction: string; input: string; output: string }[],
    dpoSamples: { prompt: string; chosen: string; rejected: string }[],
    config: Config,
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const exportDir = `${config.outputDir}/${timestamp}`;

    try {
      // Use async I/O to avoid blocking the event loop (§5.3)
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.mkdir(path.resolve(exportDir), { recursive: true });

      if (sftSamples.length > 0) {
        const sftPath = path.resolve(exportDir, "sft.jsonl");
        await fs.writeFile(sftPath, toJSONL(sftSamples as unknown as Record<string, unknown>[]));
        ctx.logger.info(`SLMDatasetExporter: Wrote ${sftSamples.length} SFT samples to ${sftPath}`);
      }

      if (dpoSamples.length > 0) {
        const dpoPath = path.resolve(exportDir, "dpo.jsonl");
        await fs.writeFile(dpoPath, toJSONL(dpoSamples as unknown as Record<string, unknown>[]));
        ctx.logger.info(`SLMDatasetExporter: Wrote ${dpoSamples.length} DPO samples to ${dpoPath}`);
      }
    } catch (err) {
      ctx.logger.warn(`SLMDatasetExporter: Disk write failed: ${(err as Error).message}`);
    }

    return exportDir;
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
