/**
 * CrossEventConsolidationModule — temporal sort, seed retrieval, LLM synthesis
 *
 * Extracted from StructMem §3.2. Implements the full consolidation pipeline:
 *  1. Cbuf = Sortτ{x ∈ Mbuffer} — temporally sort buffer
 *  2. Compute aggregated query from buffered entries
 *  3. Retrieve seed entries from previously consolidated memory
 *  4. Synthesize cross-event connections via LLM
 *  5. Fallback: pairwise similarity binding if LLM fails
 *
 * === Improvement #14 (completion): Configurable similarity function ===
 * Uses the `similarity()` strategy dispatcher instead of direct
 * `cosineSimilarity()`. Supports cosine, euclidean, and dotProduct.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — with cross-event relations
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { similarity, type SimilarityFunction } from "../../utils/similarity.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Similarity threshold for pairwise relation binding (fallback) */
  relationThreshold: z.number().min(0).max(1).default(0.7),
  /** Number of seed entries to retrieve from consolidated history */
  seedCount: z.number().default(5),
  /** Time window (ms) for timestamp-based event reconstruction and seed filtering */
  timeWindowMs: z.number().default(3600000), // 1 hour default
  /** Number of past consolidation windows to search for seeds (efficiency bound) */
  seedSearchWindow: z.number().default(10),
  /** Improvement #14: Similarity function strategy (cosine, euclidean, dotProduct) */
  similarityFunction: z.enum(["cosine", "euclidean", "dotProduct"]).default("cosine"),
});

type CrossEventConfig = z.infer<typeof ConfigSchema>;

export class CrossEventConsolidationModule implements BaseModule<CrossEventConfig> {
  readonly name = "CrossEventConsolidation";
  readonly version = "0.4.0";
  private config: CrossEventConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<CrossEventConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { connections: 0 } };
    }

    // 1. Sort buffer temporally (Cbuf = Sortτ)
    const sorted = [...units].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // 2. Aggregate query from buffered entries
    const bufferedEvents = sorted
      .map((u, i) => `[${i + 1}] (${u.type}) ${u.content}`)
      .join("\n");

    // 3. Retrieve seed entries using aggregated query + time window filtering
    let seedContext = "No prior consolidated context available.";
    if (sorted[0]?.embedding?.length > 0) {
      const dim = sorted[0].embedding.length;

      // Incremental centroid: average embedding of buffered entries
      const avgEmb = new Array(dim).fill(0);
      let count = 0;
      for (const u of sorted) {
        if (u.embedding.length === dim) {
          for (let i = 0; i < dim; i++) avgEmb[i] += u.embedding[i];
          count++;
        }
      }
      if (count > 0) for (let i = 0; i < dim; i++) avgEmb[i] /= count;

      // Compute time bounds for seed search (only recent windows)
      const latestTs = new Date(sorted[sorted.length - 1].timestamp).getTime();
      const earliestTs = new Date(sorted[0].timestamp).getTime();
      const timeCutoff = earliestTs - (this.config.timeWindowMs * this.config.seedSearchWindow);

      // Pre-filter by recency (only entries within seedSearchWindow time windows)
      const recentUnits = sorted
        .filter((u) => {
          const ts = new Date(u.timestamp).getTime();
          return ts >= timeCutoff && u.embedding?.length === dim;
        });

      // Rank by cosine similarity and filter by time proximity
      const seeds = recentUnits
        .map((u) => ({
          unit: u,
          sim: similarity(avgEmb, u.embedding, this.config.similarityFunction as SimilarityFunction),
          timeDelta: Math.abs(new Date(u.timestamp).getTime() - latestTs),
        }))
        .filter((s) => s.timeDelta <= this.config.timeWindowMs * this.config.seedSearchWindow)
        .sort((a, b) => b.sim - a.sim) // Most similar first (StructMem §3.2 Eq.4)
        .slice(0, this.config.seedCount);

      if (seeds.length > 0) {
        seedContext = seeds.map((s) => `[${s.unit.type}] ${s.unit.content}`).join("\n");
      }
    }

    // 4. Synthesize cross-event connections via LLM
    let connections = 0;
    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("structmem/consolidation_synthesis", {
        buffered_events: bufferedEvents.substring(0, 3000),
        seed_context: seedContext.substring(0, 2000),
      });

      const resp = await llm.invoke(messages);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as Array<{
        source_id?: string; target_id?: string; relation?: string; weight?: number;
      }>;

      for (const conn of parsed) {
        const si = parseInt(conn.source_id ?? "0") - 1;
        const ti = parseInt(conn.target_id ?? "0") - 1;
        if (si >= 0 && si < sorted.length && ti >= 0 && ti < sorted.length) {
          sorted[si].relations = sorted[si].relations ?? [];
          sorted[si].relations!.push({
            targetId: sorted[ti].id,
            type: conn.relation ?? "RELATES",
            weight: conn.weight ?? 0.7,
          });
          connections++;
        }
      }
    } catch {
      // 5. Fallback: pairwise cosine binding
      connections = this.bindRelations(sorted);
    }

    ctx.logger.info(
      `CrossEventConsolidation: ${connections} connections across ${sorted.length} units`,
    );

    return {
      data: { memoryUnits: sorted },
      metrics: { connections, units: sorted.length },
    };
  }

  private bindRelations(units: MemoryUnit[]): number {
    let count = 0;
    for (let i = 0; i < units.length; i++) {
      if (units[i].embedding.length === 0) continue;
      for (let j = 0; j < units.length; j++) {
        if (i === j || units[j].embedding.length === 0) continue;
        const sim = similarity(units[i].embedding, units[j].embedding, this.config.similarityFunction as SimilarityFunction);
        if (sim > this.config.relationThreshold) {
          units[i].relations = units[i].relations ?? [];
          if (!units[i].relations!.some((r) => r.targetId === units[j].id)) {
            const relType = this.inferRelationType(units[i], units[j]);
            units[i].relations!.push({ targetId: units[j].id, type: relType, weight: sim });
            count++;
          }
        }
      }
    }
    return count;
  }

  private inferRelationType(source: MemoryUnit, target: MemoryUnit): string {
    const sourceEntities = (source.metadata.entities as string[]) ?? [];
    const targetEntities = (target.metadata.entities as string[]) ?? [];
    const shared = sourceEntities.filter((e) => targetEntities.includes(e));
    const isSeq = new Date(source.timestamp).getTime() < new Date(target.timestamp).getTime();
    if (isSeq && shared.length > 0) return "CAUSAL";
    if (shared.length > 0) return "INVOLVES";
    return "TEMPORAL_FOLLOW";
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
