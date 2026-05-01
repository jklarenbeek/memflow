/**
 * StructMemModule — event-centric dual-perspective extraction
 *
 * Implements the StructMem paper (arXiv:2604.21748) core contributions:
 *
 *  1. Dual-perspective extraction (§3.1): content facts + interactional relations
 *  2. Temporal anchoring (§3.1): ISO timestamps + causal ordering
 *  3. Buffered consolidation (§3.2): events accumulate in an internal buffer;
 *     when the buffer exceeds a size threshold or time since last consolidation
 *     exceeds a time threshold, cross-event relation binding is triggered.
 *     The buffer is sorted temporally (Cbuf = Sortτ{x ∈ Mbuffer}) before
 *     semantic connections are induced.
 *  4. Persistence to Memgraph via shared MemgraphClient
 *
 * Third stage of the memory pipeline: SimpleMem → LightMem → StructMem
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";
import { loadAndRender } from "../../utils/promptLoader.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Cosine threshold for linking related memories */
  relationThreshold: z.number().min(0).max(1).default(0.7),
  /** Whether to persist to Memgraph */
  persistToGraph: z.boolean().default(true),
  /** Max recent memories to batch-persist */
  persistBatchSize: z.number().default(50),
  /** Buffer size threshold to trigger cross-event consolidation (paper §3.2) */
  consolidationThreshold: z.number().default(10),
  /** Time in ms since last consolidation before forcing a trigger */
  consolidationIntervalMs: z.number().default(60_000),
});

type StructMemConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class StructMemModule implements BaseModule<StructMemConfig> {
  readonly name = "StructMem";
  readonly version = "0.2.0";
  private config: StructMemConfig;
  private ctx?: WorkflowContext;

  /** Event buffer for cross-event consolidation (paper §3.2) */
  private eventBuffer: MemoryUnit[] = [];
  /** History of consolidated units for seed retrieval (paper §3.2) */
  private consolidatedHistory: MemoryUnit[] = [];
  /** Timestamp of last consolidation trigger */
  private lastConsolidationTime: number = Date.now();

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<StructMemConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const units: MemoryUnit[] = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0) {
      return {
        data: { memoryUnits: [] },
        metrics: { structured: 0, bufferSize: this.eventBuffer.length },
      };
    }

    ctx.logger.info(`StructMem: Structuring ${units.length} memory units`);

    // 1. Dual-perspective extraction (paper §3.1)
    //    - Content perspective: factual events with temporal references
    //    - Interactional perspective: entities and their relations
    await this.dualPerspectiveExtract(units, ctx);

    // 2. Buffer events for cross-event consolidation (paper §3.2)
    this.eventBuffer.push(...units);

    // 3. Check consolidation trigger: buffer size OR time elapsed
    const timeSinceLastConsolidation = Date.now() - this.lastConsolidationTime;
    const shouldConsolidate =
      this.eventBuffer.length >= this.config.consolidationThreshold ||
      timeSinceLastConsolidation >= this.config.consolidationIntervalMs;

    let consolidated: MemoryUnit[] = [];
    if (shouldConsolidate) {
      consolidated = await this.triggerConsolidation(ctx);

      // 4. Persist consolidated units to Memgraph
      if (this.config.persistToGraph && consolidated.length > 0) {
        await this.persist(consolidated, ctx);
      }
    }

    // Return all processed units (both buffered and consolidated)
    const allUnits = [...consolidated, ...this.eventBuffer];

    return {
      data: { memoryUnits: allUnits },
      metrics: {
        structured: units.length,
        bufferSize: this.eventBuffer.length,
        consolidated: consolidated.length,
        withRelations: allUnits.filter((u) => (u.relations?.length ?? 0) > 0)
          .length,
        entities: allUnits.reduce(
          (acc, u) => acc + ((u.metadata.entities as string[])?.length ?? 0),
          0,
        ),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Cross-event consolidation (paper §3.2)
  // -----------------------------------------------------------------------

  /**
   * Cross-event consolidation (paper §3.2).
   *
   * Full pipeline:
   *  1. Cbuf = Sortτ{x ∈ Mbuffer} — temporally sort buffer
   *  2. Compute aggregated query from buffered entries
   *  3. Retrieve seed entries from previously consolidated memory
   *  4. Synthesize cross-event connections via LLM (TOML prompt)
   *  5. Fallback: pairwise cosine binding if LLM fails
   */
  private async triggerConsolidation(ctx: WorkflowContext): Promise<MemoryUnit[]> {
    if (this.eventBuffer.length === 0) return [];

    ctx.logger.info(
      `StructMem: Consolidation triggered (${this.eventBuffer.length} buffered events)`,
    );

    // 1. Sort buffer temporally (Cbuf = Sortτ)
    const sorted = [...this.eventBuffer].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // 2. Aggregate query from buffered entries
    const bufferedEvents = sorted
      .map((u, i) => `[${i + 1}] (${u.type}) ${u.content}`)
      .join("\n");

    // 3. Retrieve seed entries from previously consolidated output
    const existingUnits = this.consolidatedHistory;
    let seedContext = "No prior consolidated context available.";
    if (existingUnits.length > 0 && sorted[0]?.embedding?.length > 0) {
      const dim = sorted[0].embedding.length;
      const avgEmb = new Array(dim).fill(0);
      let count = 0;
      for (const u of sorted) {
        if (u.embedding.length === dim) {
          for (let i = 0; i < dim; i++) avgEmb[i] += u.embedding[i];
          count++;
        }
      }
      if (count > 0) for (let i = 0; i < dim; i++) avgEmb[i] /= count;

      const seeds = existingUnits
        .filter((u) => u.embedding?.length === dim)
        .map((u) => ({ unit: u, sim: cosineSimilarity(avgEmb, u.embedding) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 5);
      if (seeds.length > 0) {
        seedContext = seeds.map((s) => `[${s.unit.type}] ${s.unit.content}`).join("\n");
      }
    }

    // 4. Synthesize cross-event connections via LLM
    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("structmem/consolidation_synthesis", {
        buffered_events: bufferedEvents.substring(0, 3000),
        seed_context: seedContext.substring(0, 2000),
      });

      const resp = await llm.invoke(messages);
      const text = typeof resp.content === "string" ? resp.content : "";
      const connections = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as Array<{
        source_id?: string; target_id?: string; relation?: string; weight?: number;
      }>;

      for (const conn of connections) {
        const si = parseInt(conn.source_id ?? "0") - 1;
        const ti = parseInt(conn.target_id ?? "0") - 1;
        if (si >= 0 && si < sorted.length && ti >= 0 && ti < sorted.length) {
          sorted[si].relations = sorted[si].relations ?? [];
          sorted[si].relations!.push({
            targetId: sorted[ti].id,
            type: conn.relation ?? "RELATES",
            weight: conn.weight ?? 0.7,
          });
        }
      }
      ctx.logger.info(`StructMem: Synthesized ${connections.length} cross-event connections`);
    } catch {
      // 5. Fallback: pairwise cosine binding
      this.bindRelations(sorted);
    }

    this.consolidatedHistory.push(...sorted);
    this.eventBuffer = [];
    this.lastConsolidationTime = Date.now();

    return sorted;
  }

  // -----------------------------------------------------------------------
  // Dual-perspective extraction (StructMem paper §3)
  // -----------------------------------------------------------------------

  /**
   * LLM-driven dual-perspective extraction.
   *
   * Per the StructMem paper, each memory unit is enriched with:
   *  1. Content perspective: temporal references extracted from text
   *  2. Interactional perspective: entities and typed relations
   *
   * Falls back to regex-based NER when LLM calls fail.
   */
  private async dualPerspectiveExtract(
    units: MemoryUnit[],
    ctx: WorkflowContext,
  ): Promise<void> {
    const llm = ctx.getLLM();

    for (const unit of units) {
      try {
        const { messages } = loadAndRender("structmem/dual_perspective", {
          content: unit.content.substring(0, 600),
        });

        const resp = await llm.invoke(messages);

        const text =
          typeof resp.content === "string" ? resp.content : "";
        const parsed = JSON.parse(
          text.match(/\{[\s\S]*\}/)?.[0] ?? "{}",
        );

        // Apply temporal anchoring from content (not just Date.now())
        unit.metadata.temporal =
          parsed.temporal ?? unit.metadata.temporal ?? new Date().toISOString();

        // Apply entity extraction
        unit.metadata.entities =
          parsed.entities?.length > 0
            ? parsed.entities
            : this.extractEntitiesFallback(unit.content);

        // Apply event type classification
        unit.metadata.eventType = parsed.eventType ?? "fact";

        // Apply interactional perspective: typed entity relations
        if (parsed.relations?.length > 0) {
          unit.metadata.interactionalRelations = parsed.relations;
        }
      } catch {
        // Fallback to regex-based extraction
        unit.metadata.temporal =
          unit.metadata.temporal ?? this.extractTemporalFallback(unit.content);
        unit.metadata.entities =
          unit.metadata.entities ?? this.extractEntitiesFallback(unit.content);
        unit.metadata.eventType = unit.metadata.eventType ?? "fact";
      }
    }
  }

  // -----------------------------------------------------------------------
  // Fallback extractors (used when LLM is unavailable)
  // -----------------------------------------------------------------------

  /** Regex-based NER fallback: extract proper nouns. */
  private extractEntitiesFallback(text: string): string[] {
    const entities: string[] = [];
    const nameMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g);
    if (nameMatch) entities.push(...nameMatch.slice(0, 5));
    return [...new Set(entities)];
  }

  /** Extract temporal references from text content. */
  private extractTemporalFallback(text: string): string {
    // Try to find date patterns in the content
    const isoMatch = text.match(
      /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?/,
    );
    if (isoMatch) return isoMatch[0];

    // Try natural language date patterns
    const naturalMatch = text.match(
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}/i,
    );
    if (naturalMatch) return new Date(naturalMatch[0]).toISOString();

    return new Date().toISOString();
  }

  // -----------------------------------------------------------------------
  // Cross-event relation binding
  // -----------------------------------------------------------------------

  /**
   * Bind relations between semantically similar units.
   *
   * Per the StructMem paper, cross-event connections are induced
   * through periodic consolidation over semantically related events.
   * Relation types are assigned based on temporal ordering and
   * entity overlap.
   */
  private bindRelations(units: MemoryUnit[]): void {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.embedding.length === 0) continue;

      for (let j = 0; j < units.length; j++) {
        if (i === j || units[j].embedding.length === 0) continue;

        const sim = cosineSimilarity(unit.embedding, units[j].embedding);
        if (sim > this.config.relationThreshold) {
          unit.relations = unit.relations ?? [];

          // Avoid duplicate relations
          if (!unit.relations.some((r) => r.targetId === units[j].id)) {
            // Determine relation type based on context
            const relType = this.inferRelationType(unit, units[j]);
            unit.relations.push({
              targetId: units[j].id,
              type: relType,
              weight: sim,
            });
          }
        }
      }
    }
  }

  /**
   * Infer the relation type between two memory units.
   *
   * Uses temporal ordering and entity overlap to classify:
   *  - TEMPORAL_FOLLOW: sequential events (temporal ordering)
   *  - INVOLVES: shared entities between events
   *  - CAUSAL: sequential with shared entities (likely cause-effect)
   */
  private inferRelationType(
    source: MemoryUnit,
    target: MemoryUnit,
  ): string {
    const sourceEntities = (source.metadata.entities as string[]) ?? [];
    const targetEntities = (target.metadata.entities as string[]) ?? [];
    const sharedEntities = sourceEntities.filter((e) =>
      targetEntities.includes(e),
    );

    const sourceTime = new Date(
      (source.metadata.temporal as string) ?? source.timestamp,
    ).getTime();
    const targetTime = new Date(
      (target.metadata.temporal as string) ?? target.timestamp,
    ).getTime();
    const isSequential = sourceTime < targetTime;

    if (isSequential && sharedEntities.length > 0) {
      return "CAUSAL";
    } else if (sharedEntities.length > 0) {
      return "INVOLVES";
    } else {
      return "TEMPORAL_FOLLOW";
    }
  }

  // -----------------------------------------------------------------------
  // Graph persistence
  // -----------------------------------------------------------------------

  private async persist(
    units: MemoryUnit[],
    ctx: WorkflowContext,
  ): Promise<void> {
    const batch = units.slice(-this.config.persistBatchSize);
    try {
      await ctx.memgraph.persistMemoryUnits(
        batch.map((u) => ({
          id: u.id,
          content: u.content,
          embedding: u.embedding,
          type: u.type,
          timestamp: u.timestamp.toISOString?.() ?? new Date().toISOString(),
          metadata: u.metadata,
          relations: u.relations,
        })),
      );
      ctx.logger.info(`StructMem: Persisted ${batch.length} units to Memgraph`);
    } catch (err) {
      ctx.logger.warn(
        `StructMem: Graph persistence failed: ${(err as Error).message}`,
      );
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}