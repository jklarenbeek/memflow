/**
 * LightMemModule — three-tier memory with topic segmentation
 *
 * Implements the LightMem paper (arXiv:2510.18866, ICLR 2026):
 *
 *  1. Sensory Memory: pre-compression via novelty gating
 *  2. Short-Term Memory (STM): topic-segmented buffer with hybrid
 *     B1∩B2 boundary detection (attention + similarity, paper §3.1)
 *  3. Long-Term Memory (LTM): soft-update at test time with
 *     timestamp-constrained similarity Q(ei) = Topk(ej, sim(vi,vj)) | tj ≥ ti
 *     plus offline parallel sleep-time consolidation (paper §3.3)
 *
 * All LLM prompts are loaded from TOML files in src/prompts/lightmem/.
 *
 * Second stage of the memory pipeline: SimpleMem → LightMem → StructMem
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
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
  /** Cosine similarity above which a new unit is considered redundant */
  noveltyThreshold: z.number().min(0).max(1).default(0.75),
  /** Compression ratio for sleep consolidation (0.3 = keep 30%) */
  compressionRatio: z.number().min(0.1).max(1).default(0.3),
  /** Maximum sensory buffer size before flushing to STM */
  sensoryBufferSize: z.number().default(50),
  /** Maximum STM capacity before triggering LTM consolidation */
  stmCapacity: z.number().default(200),
  /** Maximum LTM entries */
  ltmMaxSize: z.number().default(10000),
  /** Cosine similarity drop threshold for topic boundary detection */
  topicSimilarityThreshold: z.number().min(0).max(1).default(0.6),
});

type LightMemConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TopicSegment {
  topicId: string;
  units: MemoryUnit[];
  summary?: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LightMemModule implements BaseModule<LightMemConfig> {
  readonly name = "LightMem";
  readonly version = "0.2.0";
  private config: LightMemConfig;
  private ctx?: WorkflowContext;

  /** Tier 1: Sensory buffer — raw incoming, pre-filtered */
  private sensoryBuffer: MemoryUnit[] = [];
  /** Tier 2: Short-term memory — topic-segmented, capacity-bounded */
  private stm: TopicSegment[] = [];
  /** Tier 3: Long-term memory — consolidated abstractions */
  private ltm: MemoryUnit[] = [];

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<LightMemConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const incoming: MemoryUnit[] = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (incoming.length === 0) {
      return {
        data: { memoryUnits: this.getAllMemories() },
        metrics: { sensory: 0, stm: this.stmUnitCount(), ltm: this.ltm.length },
      };
    }

    const initialCount = incoming.length;

    // ── Tier 1: Sensory Memory — novelty gating ──────────────────────
    const novel = this.filterNovel(incoming, ctx);
    this.sensoryBuffer.push(...novel);

    // Flush sensory buffer to STM when it reaches capacity
    let sensoryFlushed = 0;
    if (this.sensoryBuffer.length >= this.config.sensoryBufferSize) {
      sensoryFlushed = this.sensoryBuffer.length;
      await this.flushSensoryToSTM(ctx);
    }

    // ── Tier 2→3: Promote STM to LTM when STM reaches capacity ──────
    let ltmPromoted = 0;
    if (this.stmUnitCount() >= this.config.stmCapacity) {
      ltmPromoted = await this.promoteSTMtoLTM(ctx);
    }

    // ── Cap LTM ──────────────────────────────────────────────────────
    if (this.ltm.length > this.config.ltmMaxSize) {
      this.ltm = this.ltm.slice(-this.config.ltmMaxSize);
    }

    // Return union of STM + LTM as the current memory state
    const allMemories = this.getAllMemories();

    return {
      data: { memoryUnits: allMemories },
      metrics: {
        inputUnits: initialCount,
        afterNoveltyFilter: novel.length,
        filtered: initialCount - novel.length,
        sensoryBufferSize: this.sensoryBuffer.length,
        sensoryFlushed,
        stmSegments: this.stm.length,
        stmUnits: this.stmUnitCount(),
        ltmUnits: this.ltm.length,
        ltmPromoted,
        totalMemories: allMemories.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Tier 1: Sensory — novelty gating
  // -----------------------------------------------------------------------

  private filterNovel(
    units: MemoryUnit[],
    ctx: WorkflowContext,
  ): MemoryUnit[] {
    if (units.length === 0) return [];

    // Compare against both existing sensory buffer and STM units
    const existingEmbeddings = [
      ...this.sensoryBuffer,
      ...this.stm.flatMap((seg) => seg.units),
    ]
      .filter((u) => u.embedding.length > 0)
      .map((u) => u.embedding);

    const kept: MemoryUnit[] = [];

    for (const candidate of units) {
      if (candidate.embedding.length === 0) {
        kept.push(candidate);
        continue;
      }

      // Check against existing memories
      const maxSimExisting =
        existingEmbeddings.length > 0
          ? Math.max(
              ...existingEmbeddings.map((e) =>
                cosineSimilarity(candidate.embedding, e),
              ),
            )
          : 0;

      // Also check against units already kept in this batch
      const maxSimBatch =
        kept.filter((k) => k.embedding.length > 0).length > 0
          ? Math.max(
              ...kept
                .filter((k) => k.embedding.length > 0)
                .map((k) => cosineSimilarity(candidate.embedding, k.embedding)),
            )
          : 0;

      const maxSim = Math.max(maxSimExisting, maxSimBatch);

      if (maxSim < this.config.noveltyThreshold) {
        kept.push(candidate);
      } else {
        ctx.logger.debug(
          `LightMem: Filtered redundant unit "${candidate.content.substring(0, 40)}…" (sim=${maxSim.toFixed(2)})`,
        );
      }
    }

    return kept;
  }

  // -----------------------------------------------------------------------
  // Tier 1→2: Sensory flush with topic segmentation
  // -----------------------------------------------------------------------

  /**
   * Hybrid topic segmentation (LightMem paper §3.1).
   *
   * Implements B = B1 ∩ B2 where:
   *  - B1: attention-based boundaries — local maxima in the sub-diagonal
   *    of the turn-level attention matrix M (approx. via embedding distances)
   *  - B2: similarity-based boundaries — sim(sk-1, sk) < τ
   *
   * Final boundaries are the intersection B1 ∩ B2.
   */
  private async flushSensoryToSTM(ctx: WorkflowContext): Promise<void> {
    const buffer = [...this.sensoryBuffer];
    this.sensoryBuffer = [];

    if (buffer.length === 0) return;
    if (buffer.length < 3) {
      // Too few units for meaningful segmentation
      this.stm.push({ topicId: uuidv4(), units: buffer });
      return;
    }

    // Compute pairwise similarities between consecutive units
    const sims: number[] = [];
    for (let i = 1; i < buffer.length; i++) {
      const prev = buffer[i - 1];
      const curr = buffer[i];
      if (prev.embedding.length > 0 && curr.embedding.length > 0) {
        sims.push(cosineSimilarity(prev.embedding, curr.embedding));
      } else {
        sims.push(1.0); // No embedding = assume continuity
      }
    }

    // B1: Attention-based boundaries — local maxima in distance
    // We approximate the sub-diagonal attention matrix M_{k,k-1} as
    // (1 - cosine_similarity), then find local maxima in this sequence.
    const distances = sims.map((s) => 1 - s);
    const b1 = new Set<number>();
    for (let k = 1; k < distances.length - 1; k++) {
      if (distances[k] > distances[k - 1] && distances[k] > distances[k + 1]) {
        b1.add(k + 1); // k+1 because boundary is after position k
      }
    }

    // B2: Similarity-based boundaries — drops below threshold τ
    const b2 = new Set<number>();
    for (let k = 0; k < sims.length; k++) {
      if (sims[k] < this.config.topicSimilarityThreshold) {
        b2.add(k + 1);
      }
    }

    // B = B1 ∩ B2 — intersection
    const boundaries = new Set<number>();
    for (const k of b1) {
      if (b2.has(k)) boundaries.add(k);
    }

    // If intersection is empty but B2 has boundaries, fall back to B2
    // (ensures we still segment when attention peaks are subtle)
    if (boundaries.size === 0) {
      for (const k of b2) boundaries.add(k);
    }

    // Segment buffer at boundary positions
    const segments: MemoryUnit[][] = [];
    let segStart = 0;
    const sortedBounds = [...boundaries].sort((a, b) => a - b);
    for (const bound of sortedBounds) {
      if (bound > segStart && bound < buffer.length) {
        segments.push(buffer.slice(segStart, bound));
        segStart = bound;
      }
    }
    segments.push(buffer.slice(segStart));

    // Add to STM
    for (const unitGroup of segments) {
      if (unitGroup.length > 0) {
        this.stm.push({
          topicId: uuidv4(),
          units: unitGroup,
        });
      }
    }

    ctx.logger.info(
      `LightMem: Flushed ${buffer.length} sensory units into ${segments.length} topic segments (B1∩B2: ${boundaries.size} boundaries)`,
    );
  }

  // -----------------------------------------------------------------------
  // Tier 2→3: STM promotion via sleep-time consolidation
  // -----------------------------------------------------------------------

  /**
   * Sleep-time consolidation with soft-update (LightMem paper §3.3).
   *
   * 1. Summarize each STM topic segment via LLM (TOML prompt)
   * 2. Soft-update existing LTM entries using paper's algorithm:
   *    Q(ei) = Topk(ej, sim(vi, vj)) | tj ≥ ti, j ≠ i
   *    Only entries with later timestamps may update earlier ones.
   * 3. Parallel execution since segments are independent.
   */
  private async promoteSTMtoLTM(ctx: WorkflowContext): Promise<number> {
    ctx.logger.info("LightMem: Sleep-time consolidation — promoting STM to LTM");

    const segmentsToPromote = this.stm.splice(
      0,
      Math.ceil(this.stm.length * this.config.compressionRatio),
    );

    let promoted = 0;
    const newEntries: MemoryUnit[] = [];

    // Parallel update: each segment is independent (paper §3.3)
    const results = await Promise.allSettled(
      segmentsToPromote.map(async (segment) => {
        const texts = segment.units.map((u) => u.content).join("\n");

        try {
          const llm = ctx.getLLM();
          const embeddings = ctx.getEmbeddings();

          // Load prompt from TOML
          const { messages } = loadAndRender("lightmem/consolidation", {
            texts: texts.substring(0, 3000),
          });

          const response = await llm.invoke(messages);

          const summaryText =
            typeof response.content === "string" ? response.content : "";
          const summaryEmb = await embeddings.embedQuery(
            summaryText.substring(0, 500),
          );

          return {
            id: uuidv4(),
            content: summaryText.substring(0, 500),
            embedding: summaryEmb,
            timestamp: new Date(),
            type: "summary" as const,
            metadata: {
              source: "sleep-consolidation",
              confidence: 0.9,
              topicId: segment.topicId,
              originalIds: segment.units.map((u) => u.id),
            },
          } satisfies MemoryUnit;
        } catch {
          // If LLM fails, keep original units as-is
          return segment.units;
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const value = result.value;
        if (Array.isArray(value)) {
          this.stm.push({ topicId: uuidv4(), units: value });
        } else {
          newEntries.push(value);
          promoted++;
        }
      }
    }

    // Soft-update existing LTM with timestamp-constrained similarity (paper §3.3)
    // Q(ei) = Topk(ej, sim(vi, vj)) | tj ≥ ti, j ≠ i
    for (const newEntry of newEntries) {
      if (newEntry.embedding.length === 0) {
        this.ltm.push(newEntry);
        continue;
      }

      // Find top-k similar existing entries that are OLDER (tj < ti for new updating old)
      const candidates = this.ltm
        .filter((existing) => {
          if (existing.embedding.length === 0) return false;
          // Only entries with earlier timestamps can be updated by newer ones
          const existingTs = existing.timestamp instanceof Date
            ? existing.timestamp.getTime()
            : new Date(existing.timestamp).getTime();
          const newTs = newEntry.timestamp instanceof Date
            ? newEntry.timestamp.getTime()
            : new Date(newEntry.timestamp).getTime();
          return newTs >= existingTs; // new entry is later
        })
        .map((existing) => ({
          entry: existing,
          sim: cosineSimilarity(newEntry.embedding, existing.embedding),
        }))
        .filter((c) => c.sim > 0.7) // Only meaningfully similar
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 3); // Top-3

      // If highly similar entries exist, merge into them (update in place)
      if (candidates.length > 0 && candidates[0].sim > 0.85) {
        const target = candidates[0].entry;
        target.content = `${target.content} [Updated: ${newEntry.content}]`
          .substring(0, 800);
        target.metadata.lastUpdated = new Date().toISOString();
        target.metadata.updateCount =
          ((target.metadata.updateCount as number) ?? 0) + 1;
        ctx.logger.debug(
          `LightMem: Soft-updated LTM entry "${target.content.substring(0, 40)}…"`,
        );
      } else {
        // No close match — insert as new entry
        this.ltm.push(newEntry);
      }
    }

    return promoted;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getAllMemories(): MemoryUnit[] {
    return [
      ...this.stm.flatMap((seg) => seg.units),
      ...this.ltm,
    ];
  }

  private stmUnitCount(): number {
    return this.stm.reduce((acc, seg) => acc + seg.units.length, 0);
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}