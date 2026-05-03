/**
 * DualSourceFusionModule — fuse local KB context with web context
 *
 * Domain-agnostic dual-source reconciliation with:
 *  - Adapter-driven authority safelists (no hardcoded domains)
 *  - Temporal freshness scoring
 *  - Conflict resolution between CLocal and CWeb
 *
 * Authority scoring is entirely config/adapter-driven:
 *  - If `authoritySafelist` is provided via config or domain adapter,
 *    URLs matching any pattern receive the `authorityBoost` multiplier.
 *  - If no safelist is present, authority scoring is skipped entirely
 *    and all web sources score equally (1.0).
 *
 * Reads:  retrievalResult, webContext, webSources
 * Writes: fusedContext (string), sources (string[])
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { DomainRegistry } from "../../gmpl/DomainRegistry.js";

const ConfigSchema = z.object({
  /** Weight for local context (0–1). Web weight = 1 − localWeight */
  localWeight: z.number().min(0).max(1).default(0.6),
  /** Boost factor for official/academic sources */
  authorityBoost: z.number().default(1.3),
  /** Penalty factor for outdated web sources (days) */
  stalenessPenalty: z.number().default(0.05),
  /** Max characters in fused context */
  maxContextChars: z.number().default(6000),
  /**
   * Authority safelist — URL patterns that receive the authority boost.
   * When empty and no domain adapter provides one, authority scoring is
   * skipped entirely (all web sources score 1.0).
   *
   * Examples: [".gov", ".edu", ".reuters.", ".nih."]
   */
  authoritySafelist: z.array(z.string()).default([]),
});

type ReconcilerConfig = z.infer<typeof ConfigSchema>;

interface SourceSegment {
  text: string;
  source: string;
  sourceType: "local" | "web";
  authorityScore: number;
  freshnessScore: number;
}

export class DualSourceFusionModule implements BaseModule<ReconcilerConfig> {
  readonly name = "DualSourceFusion";
  readonly version = "0.6.0";
  private config: ReconcilerConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<ReconcilerConfig>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const localContext = this.extractLocalContext(input.data);
    const webContext = (input.data.webContext as string) ?? "";
    const webSources = (input.data.webSources as string[]) ?? [];

    ctx.logger.info("DualSourceFusion: fusing local + web context", {
      localChars: localContext.length,
      webChars: webContext.length,
      webSourceCount: webSources.length,
    });

    // Resolve authority safelist: config → domain adapter → empty (no scoring)
    const safelist = this.resolveAuthoritySafelist(ctx);

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
          authorityScore: this.scoreAuthority(url, safelist),
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

    ctx.logger.info("DualSourceFusion: fusion complete", {
      segments: scored.length,
      fusedChars: fusedContext.length,
      sources: sources.length,
      safelistActive: safelist.length > 0,
    });

    return {
      data: { fusedContext, sources },
      metrics: {
        fusedSegments: scored.length,
        localSegments: segments.filter((s) => s.sourceType === "local").length,
        webSegments: segments.filter((s) => s.sourceType === "web").length,
        safelistEntries: safelist.length,
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

  /**
   * Resolve the effective authority safelist.
   *
   * Priority:
   *   1. Module config `authoritySafelist` (explicit override)
   *   2. Domain adapter `authoritySafelist` (via DomainRegistry)
   *   3. Empty array → no authority scoring applied
   */
  private resolveAuthoritySafelist(ctx: WorkflowContext): string[] {
    // 1. Explicit config takes precedence
    if (this.config.authoritySafelist.length > 0) {
      return this.config.authoritySafelist;
    }

    // 2. Try domain adapter
    try {
      const tenantId = ctx.globalConfig.tenantId;
      if (tenantId) {
        const registry = DomainRegistry.getInstance();
        const adapter = registry.get(tenantId);
        if (adapter?.authoritySafelist && adapter.authoritySafelist.length > 0) {
          return adapter.authoritySafelist;
        }
      }
    } catch {
      // DomainRegistry may not be initialized — fall through
    }

    // 3. No safelist → no authority scoring
    return [];
  }

  /**
   * Score authority of a URL based on the resolved safelist.
   *
   * - If safelist is empty → returns 1.0 (all sources equal)
   * - If URL matches any safelist pattern → returns authorityBoost
   * - Otherwise → returns 1.0 (neutral score)
   */
  private scoreAuthority(url: string, safelist: string[]): number {
    // No safelist → skip authority scoring entirely
    if (safelist.length === 0) return 1.0;

    const lower = url.toLowerCase();
    for (const pattern of safelist) {
      if (lower.includes(pattern.toLowerCase())) {
        return this.config.authorityBoost;
      }
    }

    // URL doesn't match any safelist entry → neutral
    return 1.0;
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
