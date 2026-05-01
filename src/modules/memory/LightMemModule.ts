/**
 * LightMemModule — three-tier memory with topic segmentation
 *
 * Implements the LightMem paper (arXiv:2510.18866, ICLR 2026):
 *
 *  1. Sensory Memory: pre-compression via novelty gating — units with
 *     cosine similarity above threshold are filtered as redundant
 *  2. Short-Term Memory (STM): topic-segmented buffer with capacity-bounded
 *     accumulation. When STM reaches capacity, units are summarized per-topic
 *     and promoted to LTM
 *  3. Long-Term Memory (LTM): sleep-time offline parallel updates with
 *     abstractive consolidation via LLM
 *
 * Topic segmentation (§3.1): identifies topic boundaries via pairwise
 * cosine similarity drops between adjacent units, matching the paper's
 * hybrid attention + similarity boundary detection (simplified to
 * similarity-only for workflow-module compatibility).
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
  readonly version = "3.0.0";
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
   * Topic segmentation (LightMem paper §3.1).
   *
   * Identifies topic boundaries by computing cosine similarity between
   * adjacent units. When similarity drops below `topicSimilarityThreshold`,
   * a new topic segment begins. This matches the paper's B2 boundary set.
   */
  private async flushSensoryToSTM(ctx: WorkflowContext): Promise<void> {
    const buffer = [...this.sensoryBuffer];
    this.sensoryBuffer = [];

    if (buffer.length === 0) return;

    // Detect topic boundaries via similarity drops
    const segments: MemoryUnit[][] = [];
    let currentSegment: MemoryUnit[] = [buffer[0]];

    for (let i = 1; i < buffer.length; i++) {
      const prev = buffer[i - 1];
      const curr = buffer[i];

      if (prev.embedding.length > 0 && curr.embedding.length > 0) {
        const sim = cosineSimilarity(prev.embedding, curr.embedding);
        if (sim < this.config.topicSimilarityThreshold) {
          // Topic boundary detected
          segments.push(currentSegment);
          currentSegment = [curr];
          continue;
        }
      }

      currentSegment.push(curr);
    }
    segments.push(currentSegment);

    // Convert to TopicSegments and add to STM
    for (const unitGroup of segments) {
      this.stm.push({
        topicId: uuidv4(),
        units: unitGroup,
      });
    }

    ctx.logger.info(
      `LightMem: Flushed ${buffer.length} sensory units into ${segments.length} topic segments`,
    );
  }

  // -----------------------------------------------------------------------
  // Tier 2→3: STM promotion via sleep-time consolidation
  // -----------------------------------------------------------------------

  /**
   * Sleep-time consolidation (LightMem paper §3.3).
   *
   * Summarizes each STM topic segment via LLM, producing compact LTM
   * entries. Updates are parallelizable since each topic segment is
   * independent (paper's "offline parallel update" property).
   */
  private async promoteSTMtoLTM(ctx: WorkflowContext): Promise<number> {
    ctx.logger.info("LightMem: Sleep-time consolidation — promoting STM to LTM");

    const segmentsToPromote = this.stm.splice(
      0,
      Math.ceil(this.stm.length * this.config.compressionRatio),
    );

    let promoted = 0;

    // Parallel update: each segment is independent (paper §3.3)
    const results = await Promise.allSettled(
      segmentsToPromote.map(async (segment) => {
        const texts = segment.units.map((u) => u.content).join("\n");

        try {
          const llm = ctx.getLLM();
          const embeddings = ctx.getEmbeddings();

          const response = await llm.invoke([
            {
              role: "user",
              content: `Consolidate these related memory entries into a single concise summary that preserves key facts and relationships:\n${texts.substring(0, 3000)}`,
            },
          ]);

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
          // LLM failed — push original units back to STM
          this.stm.push({
            topicId: uuidv4(),
            units: value,
          });
        } else {
          this.ltm.push(value);
          promoted++;
        }
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