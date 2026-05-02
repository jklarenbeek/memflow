/**
 * PriHAFusionModule — backward-compatible wrapper
 *
 * Delegates to the priha-fusion sub-workflow:
 *   QueryClarifier → AnswerGenerator → HallucinationValidator → CitationInjector
 *
 * This module retains the original API surface and ConfigSchema so that
 * existing workflow JSON references continue to work unchanged.
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
  enableTriage: z.boolean().default(true),
  enableDualSource: z.boolean().default(true),
  enableValidation: z.boolean().default(true),
  citationStyle: z.enum(["inline", "footnote"]).default("inline"),
  maxCitations: z.number().default(6),
  maxContextTokens: z.number().default(7000),
  /** Max depth for iterative query clarification (PHC-O pattern) */
  maxClarificationDepth: z.number().default(2),
  /** Max sub-queries to decompose a fuzzy query into */
  maxSubQueries: z.number().default(3),
});

type PriHAConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class PriHAFusionModule implements BaseModule<PriHAConfig> {
  readonly name = "PriHAFusion";
  readonly version = "0.3.0";
  private config: PriHAConfig;
  private subWorkflow: SubWorkflowModule;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
    this.subWorkflow = new SubWorkflowModule({
      workflowRef: "src/workflows/sub/priha-fusion.json",
      inputMap: {
        query: "query",
        retrievalResult: "retrievalResult",
        finalAnswer: "finalAnswer",
      },
      outputMap: {
        finalAnswer: "finalAnswer",
        sources: "sources",
        confidence: "confidence",
      },
    });
  }

  async init(context: unknown): Promise<void> {
    // No-op — child engine shares parent context
  }

  async process(
    input: ModuleInput<PriHAConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;
    ctx?.logger.info("PriHAFusion: Delegating to priha-fusion sub-workflow");

    // Map composite config to per-stage overrides
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

  /**
   * Map the composite's flat config to per-stage atomic module configs.
   * This preserves backward compatibility — callers pass the same config
   * keys as before, and they are routed to the correct atomic modules.
   */
  private buildStageConfigs(): Record<string, Record<string, unknown>> {
    return {
      clarify: {
        maxClarificationDepth: this.config.enableTriage
          ? this.config.maxClarificationDepth
          : 0,
        maxSubQueries: this.config.maxSubQueries,
      },
      generate: {
        enableDualSource: this.config.enableDualSource,
        maxContextTokens: this.config.maxContextTokens,
      },
      validate: {
        enabled: this.config.enableValidation,
      },
      cite: {
        style: this.config.citationStyle,
        maxCitations: this.config.maxCitations,
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
