/**
 * LightRAGRetrieverModule — backward-compatible wrapper
 *
 * Delegates to the hybrid-retrieval sub-workflow:
 *   IntentClassifier → [VectorSearch ∥ GraphSearch ∥ KeywordSearch] → ResultRanker
 *
 * This module retains the original API surface and ConfigSchema so that
 * existing workflow JSON references continue to work unchanged.
 *
 * NOTE: The LightRAG paper's incremental graph index update algorithm is
 * handled externally by MemgraphGraphModule. This module focuses solely
 * on the retrieval path.
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  RetrievalResult,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { SubWorkflowModule } from "../../core/SubWorkflowModule.js";

// ---------------------------------------------------------------------------
// Config — preserves original API surface
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  topK: z.number().default(8),
  useGraph: z.boolean().default(true),
  useVector: z.boolean().default(true),
  usePyramid: z.boolean().default(true),
  intentAware: z.boolean().default(true),
  hybridWeights: z
    .object({
      vector: z.number().default(0.5),
      graph: z.number().default(0.3),
      keyword: z.number().default(0.2),
    })
    .default({}),
  tokenBudget: z.number().default(4000),
});

type RetrieverConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LightRAGRetrieverModule implements BaseModule<RetrieverConfig> {
  readonly name = "LightRAGRetriever";
  readonly version = "0.3.0";
  private config: RetrieverConfig;
  private subWorkflow: SubWorkflowModule;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/hybrid-retrieval.json",
      inputMap: {
        query: "query",
      },
      outputMap: {
        retrievalResult: "retrievalResult",
        graphContext: "graphContext",
      },
    });
  }

  async init(context: unknown): Promise<void> {
    // No-op — child engine shares parent context
  }

  async process(
    input: ModuleInput<RetrieverConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;
    const query = (input.data.query as string) ?? "";

    if (!query.trim()) {
      return { data: { retrievalResult: emptyResult() }, metrics: { hits: 0 } };
    }

    ctx?.logger.info(
      `LightRAGRetriever: Delegating to hybrid-retrieval sub-workflow`,
    );

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
      intent: {
        enabled: this.config.intentAware,
      },
      vector: {
        topK: this.config.topK * 2,
        weight: this.config.hybridWeights.vector,
        enabled: this.config.useVector,
      },
      graph: {
        topK: this.config.topK,
        weight: this.config.hybridWeights.graph,
        enabled: this.config.useGraph,
      },
      keyword: {
        topK: this.config.topK,
        weight: this.config.hybridWeights.keyword,
      },
      rank: {
        topK: this.config.topK,
        tokenBudget: this.config.tokenBudget,
        usePyramid: this.config.usePyramid,
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

function emptyResult(): RetrievalResult {
  return { chunks: [], memories: [], graphPaths: [], score: 0, sources: [] };
}