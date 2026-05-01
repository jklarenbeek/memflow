/**
 * AutonomousLoopModule — OMNI-SIMPLEMEM §3 iterative diagnosis and repair
 *
 * Meta-module that wraps a sub-workflow in an autonomous optimization loop:
 *  1. Execute the target sub-workflow
 *  2. Evaluate output metrics against configurable targets
 *  3. If below target: diagnose failure via LLM, generate config mutations
 *  4. Re-execute with mutated config
 *  5. Accept or revert based on metric delta
 *
 * This implements the paper's key insight that an autonomous agent can
 * iteratively diagnose and repair retrieval/generation failures without
 * human intervention.
 *
 * Usage: wrap any sub-workflow stage in an autonomous loop:
 * ```json
 * {
 *   "id": "auto_retrieve",
 *   "module": "AutonomousLoop",
 *   "config": {
 *     "workflowRef": "src/workflows/sub/hybrid-retrieval.json",
 *     "targetMetric": "retrievalResult.score",
 *     "targetThreshold": 0.7,
 *     "maxIterations": 3
 *   }
 * }
 * ```
 *
 * Reads:  (passthrough to child workflow)
 * Writes: (passthrough from child workflow) + autonomousLoopMetrics
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { SubWorkflowModule } from "../../core/SubWorkflowModule.js";

const ConfigSchema = z.object({
  /** Path to the sub-workflow to wrap in the loop */
  workflowRef: z.string(),
  /** Dot-path to the metric in output data to evaluate (e.g. "retrievalResult.score") */
  targetMetric: z.string().default("score"),
  /** Minimum acceptable value for targetMetric */
  targetThreshold: z.number().default(0.7),
  /** Maximum loop iterations */
  maxIterations: z.number().default(3),
  /** Input mapping for the child workflow */
  inputMap: z.record(z.string()).default({}),
  /** Output mapping from the child workflow */
  outputMap: z.record(z.string()).default({}),
});

type AutonomousLoopConfig = z.infer<typeof ConfigSchema>;

export class AutonomousLoopModule implements BaseModule<AutonomousLoopConfig> {
  readonly name = "AutonomousLoop";
  readonly version = "0.1.0";
  private config: AutonomousLoopConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<AutonomousLoopConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    let bestResult: ModuleOutput | null = null;
    let bestScore = -Infinity;
    let currentInput = { ...input.data };
    const iterationLog: Array<{
      iteration: number;
      score: number;
      diagnosis: string;
      accepted: boolean;
    }> = [];

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      // 1. Execute sub-workflow
      const subWorkflow = new SubWorkflowModule({
        workflowRef: this.config.workflowRef,
        inputMap: this.config.inputMap,
        outputMap: this.config.outputMap,
      });

      const result = await subWorkflow.process(
        { data: currentInput, config: {} },
        context,
      );

      // 2. Evaluate metric
      const score = this.extractMetric(result.data, this.config.targetMetric);

      ctx.logger.info(
        `AutonomousLoop: iteration ${iteration + 1}/${this.config.maxIterations}, ` +
        `metric=${this.config.targetMetric}, score=${score.toFixed(3)}, target=${this.config.targetThreshold}`,
      );

      // Track best result
      const accepted = score > bestScore;
      if (accepted) {
        bestScore = score;
        bestResult = result;
      }

      // 3. Check if target is met
      if (score >= this.config.targetThreshold) {
        iterationLog.push({ iteration, score, diagnosis: "target_met", accepted: true });
        ctx.logger.info(`AutonomousLoop: target met at iteration ${iteration + 1}`);
        break;
      }

      // 4. Diagnose failure and generate mutations
      let diagnosis = "unknown";
      try {
        const llm = ctx.getLLM();
        const diagResp = await llm.invoke([
          {
            role: "system",
            content: `You are a diagnostic agent for a RAG pipeline. The pipeline produced a score of ${score.toFixed(3)} against a target of ${this.config.targetThreshold}.

Analyze the output and suggest ONE specific configuration change to improve the score.

Respond with JSON:
{
  "diagnosis": "brief problem description",
  "mutation": {
    "field": "data field to modify",
    "action": "expand|narrow|rephrase|add_context",
    "value": "new value or instruction"
  }
}`,
          },
          {
            role: "user",
            content: `Current query: ${(currentInput as any).query ?? "unknown"}\nScore: ${score}\nResult summary: ${JSON.stringify(result.data).substring(0, 500)}`,
          },
        ]);

        const diagText = typeof diagResp.content === "string" ? diagResp.content : "";
        const parsed = JSON.parse(diagText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        diagnosis = parsed.diagnosis ?? "unknown";

        // 5. Apply mutation
        if (parsed.mutation?.field && parsed.mutation?.value) {
          currentInput = {
            ...currentInput,
            [parsed.mutation.field]: parsed.mutation.value,
          };
          ctx.logger.debug(`AutonomousLoop: applying mutation to "${parsed.mutation.field}"`);
        } else {
          // Fallback: expand the query
          const query = (currentInput as any).query;
          if (query) {
            (currentInput as any).query = `${query} (please provide more detail and context)`;
          }
        }
      } catch {
        diagnosis = "diagnosis_failed";
      }

      iterationLog.push({ iteration, score, diagnosis, accepted });
    }

    // Return best result with loop metadata
    const finalResult = bestResult ?? {
      data: input.data,
      metrics: {},
    };

    return {
      data: {
        ...finalResult.data,
        autonomousLoopMetrics: {
          iterations: iterationLog.length,
          bestScore,
          targetMet: bestScore >= this.config.targetThreshold,
          iterationLog,
        },
      },
      metrics: {
        ...(finalResult.metrics ?? {}),
        loopIterations: iterationLog.length,
        bestScore,
        targetMet: bestScore >= this.config.targetThreshold,
      },
    };
  }

  /**
   * Extract a metric value from output data using a dot-path.
   * E.g. "retrievalResult.score" → data.retrievalResult.score
   */
  private extractMetric(data: Record<string, unknown>, path: string): number {
    const parts = path.split(".");
    let current: unknown = data;

    for (const part of parts) {
      if (current == null || typeof current !== "object") return 0;
      current = (current as Record<string, unknown>)[part];
    }

    return typeof current === "number" ? current : 0;
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}
