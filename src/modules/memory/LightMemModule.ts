/**
 * LightMemModule — backward-compatible wrapper
 *
 * Delegates to the lightmem-pipeline sub-workflow:
 *   NoveltyGate → TopicSegmenter → SleepConsolidation
 *
 * Retains the stateful three-tier memory architecture:
 *  - Tier 1 (Sensory): capacity-gated buffer for incoming units
 *  - Tier 2 (STM): topic-segmented memory, capacity-bounded
 *  - Tier 3 (LTM): consolidated long-term memory
 *
 * The wrapper manages tier transitions (when to flush sensory → STM,
 * when to promote STM → LTM) while the sub-workflow handles the
 * algorithmic processing (novelty filtering, B1∩B2 segmentation,
 * sleep consolidation with soft-update semantics).
 *
 * Second stage of the memory pipeline: SimpleMem → LightMem → StructMem
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { SubWorkflowModule } from "../core/SubWorkflowModule.js";

// ---------------------------------------------------------------------------
// Config — preserves original API surface
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
// Module
// ---------------------------------------------------------------------------

export class LightMemModule implements BaseModule<LightMemConfig> {
  readonly name = "LightMem";
  readonly version = "0.5.0";
  private config: LightMemConfig;
  private subWorkflow: SubWorkflowModule;

  /** Tier 1: Sensory buffer — raw incoming, pre-filtered */
  private sensoryBuffer: MemoryUnit[] = [];
  /** Tier 2: Short-term memory — topic-segmented, capacity-bounded */
  private stmUnits: MemoryUnit[] = [];
  /** Tier 3: Long-term memory — consolidated abstractions */
  private ltm: MemoryUnit[] = [];

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/lightmem-pipeline.json",
      inputMap: {
        memoryUnits: "memoryUnits",
      },
      outputMap: {
        memoryUnits: "memoryUnits",
        topicSegments: "topicSegments",
      },
    });
  }

  async init(context: unknown): Promise<void> {
    // No-op — child engine shares parent context
  }

  async process(
    input: ModuleInput<LightMemConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;
    const incoming: MemoryUnit[] = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (incoming.length === 0) {
      return {
        data: { memoryUnits: this.getAllMemories() },
        metrics: {
          sensory: 0,
          stmUnits: this.stmUnits.length,
          ltm: this.ltm.length,
        },
      };
    }

    ctx?.logger.info(
      `LightMem: Processing ${incoming.length} units through tier pipeline`,
    );

    // Add incoming to sensory buffer
    this.sensoryBuffer.push(...incoming);

    let sensoryFlushed = 0;
    let ltmPromoted = 0;
    let flushMetrics: Record<string, unknown> = {};
    let consolMetrics: Record<string, unknown> = {};

    // Tier 1→2: Flush sensory to STM when buffer reaches capacity
    if (this.sensoryBuffer.length >= this.config.sensoryBufferSize) {
      sensoryFlushed = this.sensoryBuffer.length;

      // Delegate novelty + segmentation to sub-workflow
      const stageOverrides = this.buildStageConfigs();
      const result = await this.subWorkflow.process(
        {
          data: {
            memoryUnits: this.sensoryBuffer,
            existingMemories: [...this.stmUnits, ...this.ltm],
            _stageConfigs: stageOverrides,
          },
          config: {},
        },
        context,
      );

      const processed = (result.data.memoryUnits ?? []) as MemoryUnit[];
      this.stmUnits.push(...processed);
      this.sensoryBuffer = [];
      flushMetrics = result.metrics ?? {};
    }

    // Tier 2→3: Promote STM to LTM when STM reaches capacity
    if (this.stmUnits.length >= this.config.stmCapacity) {
      const toPromote = this.stmUnits.splice(
        0,
        Math.ceil(this.stmUnits.length * this.config.compressionRatio),
      );

      // Use the consolidation part of the sub-workflow
      const consolResult = await this.subWorkflow.process(
        {
          data: {
            memoryUnits: toPromote,
            _stageConfigs: this.buildStageConfigs(),
          },
          config: {},
        },
        context,
      );

      const consolidated = (consolResult.data.memoryUnits ?? []) as MemoryUnit[];
      this.ltm.push(...consolidated);
      ltmPromoted = consolidated.length;
      consolMetrics = consolResult.metrics ?? {};
    }

    // Cap LTM
    if (this.ltm.length > this.config.ltmMaxSize) {
      this.ltm = this.ltm.slice(-this.config.ltmMaxSize);
    }

    const allMemories = this.getAllMemories();

    return {
      data: { memoryUnits: allMemories },
      metrics: {
        inputUnits: incoming.length,
        sensoryBufferSize: this.sensoryBuffer.length,
        sensoryFlushed,
        stmUnits: this.stmUnits.length,
        ltmUnits: this.ltm.length,
        ltmPromoted,
        totalMemories: allMemories.length,
        ...flushMetrics,
        ...consolMetrics,
        delegated: true,
      },
    };
  }

  private getAllMemories(): MemoryUnit[] {
    return [...this.stmUnits, ...this.ltm];
  }

  private buildStageConfigs(): Record<string, Record<string, unknown>> {
    return {
      sensory_buffer: {
        bufferCapacity: 1, // always flush so the full pipeline runs
      },
      novelty: {
        noveltyThreshold: this.config.noveltyThreshold,
      },
      segment: {
        topicSimilarityThreshold: this.config.topicSimilarityThreshold,
      },
      consolidate: {
        ltmMaxSize: this.config.ltmMaxSize,
      },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}