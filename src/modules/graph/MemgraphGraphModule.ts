/**
 * MemgraphGraphModule — backward-compatible wrapper
 *
 * Delegates to the graph-indexing sub-workflow:
 *   ChunkIngestor → EntityExtractor → EntityDeduplicator → EntityProfiler → CommunityDetector
 *
 * This module retains the original API surface and ConfigSchema so that
 * existing workflow JSON references continue to work unchanged.
 *
 * NOTE: The original composite included a step 7 (hybrid search to prepare
 * graphContext). This retrieval concern has been removed — retrieval is
 * handled by the hybrid-retrieval sub-workflow. An empty graphContext is
 * returned for backward compatibility.
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
  vectorDim: z.number().default(768),
  useMAGE: z.boolean().default(true),
  /** Max chunks to process with LLM entity extraction per batch */
  maxChunksForExtraction: z.number().default(50),
  /** Enable LLM-driven deduplication */
  enableDeduplication: z.boolean().default(true),
  /** Enable LLM-driven entity profiling */
  enableProfiling: z.boolean().default(true),
});

type GraphConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class MemgraphGraphModule implements BaseModule<GraphConfig> {
  readonly name = "MemgraphGraph";
  readonly version = "0.5.0";
  private config: GraphConfig;
  private subWorkflow: SubWorkflowModule;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/graph-indexing.json",
      inputMap: {
        chunks: "chunks",
        documents: "documents",
        embeddings: "embeddings",
      },
      outputMap: {
        entities: "entities",
        relationships: "relationships",
      },
    });
  }

  async process(
    input: ModuleInput<GraphConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    ctx.logger.info("MemgraphGraph: Delegating to graph-indexing sub-workflow");

    const stageOverrides = this.buildStageConfigs();

    const result = await this.subWorkflow.process(
      {
        data: { ...input.data, _stageConfigs: stageOverrides },
        config: {},
      },
      context,
    );

    // Backward compat: return empty graphContext (retrieval is a separate concern)
    return {
      data: {
        ...result.data,
        graphContext: "",
      },
      metrics: {
        ...result.metrics,
        delegated: true,
      },
    };
  }

  private buildStageConfigs(): Record<string, Record<string, unknown>> {
    return {
      ingest: {
        vectorDim: this.config.vectorDim,
      },
      extract_entities: {
        maxChunks: this.config.maxChunksForExtraction,
      },
      deduplicate: {
        useLLM: this.config.enableDeduplication,
      },
      profile: {
        enabled: this.config.enableProfiling,
      },
      communities: {
        enabled: this.config.useMAGE,
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