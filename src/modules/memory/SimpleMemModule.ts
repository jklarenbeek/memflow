/**
 * SimpleMemModule — backward-compatible wrapper
 *
 * Delegates to the simplemem-pipeline sub-workflow:
 *   SlidingWindow → DensityGate → FactExtractor → SemanticSynthesis → StructuredIndex
 *
 * This module retains the original API surface and ConfigSchema so that
 * existing workflow JSON references continue to work unchanged.
 *
 * First stage of the 3-module memory pipeline:
 *   SimpleMem → LightMem → StructMem
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { SubWorkflowModule } from "../core/SubWorkflowModule.js";

// ---------------------------------------------------------------------------
// Config — preserves original API surface
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Cosine similarity threshold for merging similar memories */
  synthesisThreshold: z.number().min(0).max(1).default(0.82),
  /** Compression ratio target (0.3 = keep ~30% of original tokens) */
  compressionRatio: z.number().min(0.1).max(1).default(0.3),
  /** Max characters to send to LLM for extraction */
  maxInputChars: z.number().default(2000),
  /** Number of recent memories to consider for synthesis */
  synthesisWindow: z.number().default(20),
  /** Sliding window size (number of chunks per window) — paper §2 */
  windowSize: z.number().min(1).default(5),
  /** Overlap between adjacent windows */
  windowOverlap: z.number().min(0).default(2),
  /** Enable semantic density gating (paper Eq. 1) */
  enableDensityGating: z.boolean().default(true),
});

type SimpleMemConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SimpleMemModule implements BaseModule<SimpleMemConfig> {
  readonly name = "SimpleMem";
  readonly version = "0.3.0";
  private config: SimpleMemConfig;
  private subWorkflow: SubWorkflowModule;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/simplemem-pipeline.json",
      inputMap: {
        chunks: "chunks",
        documents: "documents",
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
    input: ModuleInput<SimpleMemConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;
    ctx?.logger.info("SimpleMem: Delegating to simplemem-pipeline sub-workflow");

    const stageOverrides = this.buildStageConfigs();

    const result = await this.subWorkflow.process(
      {
        data: { ...input.data, _stageConfigs: stageOverrides },
        config: {},
      },
      context,
    );

    return {
      data: result.data,
      metrics: {
        ...result.metrics,
        delegated: true,
      },
    };
  }

  private buildStageConfigs(): Record<string, Record<string, unknown>> {
    return {
      window: {
        windowSize: this.config.windowSize,
        windowOverlap: this.config.windowOverlap,
      },
      gate: {
        useLLM: this.config.enableDensityGating,
      },
      synthesize: {
        synthesisThreshold: this.config.synthesisThreshold,
      },
      index: {
        maxKeywords: 10,
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