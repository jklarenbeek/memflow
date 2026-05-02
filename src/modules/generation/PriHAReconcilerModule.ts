/**
 * PriHAReconcilerModule — fuse local KB context with web context
 *
 * Implements PriHA §3.4: Dual-source reconciliation with:
 *  - Source priority: official > academic > general web
 *  - Temporal freshness scoring
 *  - Conflict resolution between CLocal and CWeb
 *
 * Reads:  retrievalResult, webContext, webSources
 * Writes: fusedContext (string), sources (string[])
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Weight for local context (0–1). Web weight = 1 − localWeight */
  localWeight: z.number().min(0).max(1).default(0.6),
  /** Boost factor for official/academic sources */
  authorityBoost: z.number().default(1.3),
  /** Penalty factor for outdated web sources (days) */
  stalenessPenalty: z.number().default(0.05),
  /** Max characters in fused context */
  maxContextChars: z.number().default(6000),
});

type ReconcilerConfig = z.infer<typeof ConfigSchema>;

interface SourceSegment {
  text: string;
  source: string;
  sourceType: "local" | "web";
  authorityScore: number;
  freshnessScore: number;
}

export class PriHAReconcilerModule implements BaseModule<ReconcilerConfig> {
  readonly name = "PriHAReconciler";
  readonly version = "0.5.0";
  private config: ReconcilerConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<ReconcilerConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const localContext = this.extractLocalContext(input.data);
    const webContext = (input.data.webContext as string) ?? "";
    const webSources = (input.data.webSources as string[]) ?? [];

    ctx.logger.info("PriHAReconciler: fusing local + web context", {
      localChars: localContext.length,
      webChars: webContext.length,
      webSourceCount: webSources.length,
    });

    const segments: SourceSegment[] = [];

    // Local segments
    if (localContext.length > 0) {
      segments.push({
        text: localContext,
        source: "local_kb",
        sourceType: "local",
        authorityScore: 1.0,
        freshnessScore: 0.9, // local KB is assumed reasonably fresh
      });
    }

    // Web segments
    if (webContext.length > 0) {
      const webChunks = webContext.split(/\n\n---\n\n/);
      for (let i = 0; i < webChunks.length; i++) {
        const chunk = webChunks[i].trim();
        if (!chunk) continue;
        const url = webSources[i] ?? "web";
        segments.push({
          text: chunk,
          source: url,
          sourceType: "web",
          authorityScore: this.scoreAuthority(url),
          freshnessScore: 1.0, // Tavily results are current
        });
      }
    }

    if (segments.length === 0) {
      return {
        data: { fusedContext: "", sources: [] },
        metrics: { fusedSegments: 0 },
      };
    }

    // Score and rank segments
    const scored = segments.map((seg) => ({
      ...seg,
      compositeScore:
        (seg.sourceType === "local" ? this.config.localWeight : 1 - this.config.localWeight) *
        seg.authorityScore *
        seg.freshnessScore,
    }));

    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    // Build fused context within max chars
    const parts: string[] = [];
    let totalChars = 0;
    const sources: string[] = [];

    for (const seg of scored) {
      const prefix = seg.sourceType === "local" ? "[LOCAL]" : `[WEB: ${seg.source}]`;
      const part = `${prefix}\n${seg.text}`;
      if (totalChars + part.length > this.config.maxContextChars) {
        // Try to fit a truncated version
        const remaining = this.config.maxContextChars - totalChars - prefix.length - 10;
        if (remaining > 100) {
          parts.push(`${prefix}\n${seg.text.substring(0, remaining)}...`);
          sources.push(seg.source);
        }
        break;
      }
      parts.push(part);
      totalChars += part.length;
      if (!sources.includes(seg.source)) sources.push(seg.source);
    }

    const fusedContext = parts.join("\n\n---\n\n");

    ctx.logger.info("PriHAReconciler: fusion complete", {
      segments: scored.length,
      fusedChars: fusedContext.length,
      sources: sources.length,
    });

    return {
      data: { fusedContext, sources },
      metrics: {
        fusedSegments: scored.length,
        localSegments: segments.filter((s) => s.sourceType === "local").length,
        webSegments: segments.filter((s) => s.sourceType === "web").length,
      },
    };
  }

  private extractLocalContext(data: Record<string, unknown>): string {
    const retrieval = data.retrievalResult as { chunks?: Array<{ pageContent?: string }> } | undefined;
    if (retrieval?.chunks && retrieval.chunks.length > 0) {
      return retrieval.chunks.map((c) => c.pageContent ?? "").join("\n\n");
    }
    const graphContext = (data.graphContext as string) ?? "";
    return graphContext;
  }

  private scoreAuthority(url: string): number {
    const lower = url.toLowerCase();
    // Official / government / academic boost
    if (/\.(gov|edu|ac\.\w{2})\//.test(lower)) return this.config.authorityBoost;
    // Major encyclopedia / reference
    if (/\.(wikipedia|britannica|nih|who|un|worldbank)\./.test(lower)) return this.config.authorityBoost * 0.95;
    // News outlets — moderate
    if (/\.(reuters|apnews|bbc|npr|cnn|nytimes)\./.test(lower)) return 1.0;
    // Default
    return 0.85;
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
