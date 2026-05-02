/**
 * StructMemModule — backward-compatible wrapper
 *
 * Delegates to the structmem-pipeline sub-workflow:
 *   DualPerspective → CrossEventConsolidation → GraphPersist
 *
 * Retains the stateful event buffer and consolidation trigger logic
 * (buffer size OR time elapsed) that determines WHEN to invoke the
 * sub-workflow. The algorithmic logic (sort, seed, synthesize, bind,
 * persist) is fully delegated to the atomic modules.
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
import { SubWorkflowModule } from "../core/SubWorkflowModule.js";

// ---------------------------------------------------------------------------
// Config — preserves original API surface
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
  readonly version = "0.3.0";
  private config: StructMemConfig;
  private subWorkflow: SubWorkflowModule;

  /** Event buffer for cross-event consolidation (paper §3.2) */
  private eventBuffer: MemoryUnit[] = [];
  /** Timestamp of last consolidation trigger */
  private lastConsolidationTime: number = Date.now();

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/structmem-pipeline.json",
      inputMap: {
        memoryUnits: "memoryUnits",
      },
      outputMap: {
        memoryUnits: "memoryUnits",
      },
    });
  }

  async init(context: unknown): Promise<void> {
    // No-op — child engine shares parent context
  }

  async process(
    input: ModuleInput<StructMemConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;
    const units: MemoryUnit[] = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0) {
      return {
        data: { memoryUnits: [] },
        metrics: { structured: 0, bufferSize: this.eventBuffer.length },
      };
    }

    ctx?.logger.info(`StructMem: Buffering ${units.length} memory units`);

    // Buffer events for cross-event consolidation (paper §3.2)
    this.eventBuffer.push(...units);

    // Check consolidation trigger: buffer size OR time elapsed
    const timeSinceLastConsolidation = Date.now() - this.lastConsolidationTime;
    const shouldConsolidate =
      this.eventBuffer.length >= this.config.consolidationThreshold ||
      timeSinceLastConsolidation >= this.config.consolidationIntervalMs;

    if (!shouldConsolidate) {
      return {
        data: { memoryUnits: [...this.eventBuffer] },
        metrics: {
          structured: units.length,
          bufferSize: this.eventBuffer.length,
          consolidated: 0,
        },
      };
    }

    // Delegate consolidation to sub-workflow
    ctx?.logger.info(
      `StructMem: Consolidation triggered (${this.eventBuffer.length} buffered events), delegating to sub-workflow`,
    );

    const stageOverrides = this.buildStageConfigs();
    const bufferSnapshot = [...this.eventBuffer];

    const result = await this.subWorkflow.process(
      {
        data: {
          memoryUnits: bufferSnapshot,
          _stageConfigs: stageOverrides,
        },
        config: {},
      },
      context,
    );

    // Reset buffer after successful consolidation
    this.eventBuffer = [];
    this.lastConsolidationTime = Date.now();

    const consolidated = (result.data.memoryUnits ?? []) as MemoryUnit[];

    return {
      data: { memoryUnits: consolidated },
      metrics: {
        structured: units.length,
        bufferSize: 0,
        consolidated: consolidated.length,
        ...result.metrics,
        delegated: true,
      },
    };
  }

  private buildStageConfigs(): Record<string, Record<string, unknown>> {
    return {
      consolidate: {
        relationThreshold: this.config.relationThreshold,
      },
      persist: {
        batchSize: this.config.persistBatchSize,
        enabled: this.config.persistToGraph,
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