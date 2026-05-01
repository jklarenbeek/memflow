/**
 * FinalSynthesizerModule — synthesize agent trajectory into polished answer
 *
 * Extracted from HERA orchestrator. Takes the accumulated agent trajectory
 * steps and produces a final, coherent answer via LLM synthesis.
 *
 * Reads:  trajectory (AgentTrajectory)
 * Writes: finalAnswer (string), trajectory (enriched with finalAnswer)
 */

import { z } from "zod";
import type {
  StreamableModule,
  ModuleInput,
  ModuleOutput,
  AgentTrajectory,
  StreamEvent,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Max characters per step result to include in synthesis prompt */
  maxStepChars: z.number().default(400),
});

type FinalSynthesizerConfig = z.infer<typeof ConfigSchema>;

export class FinalSynthesizerModule implements StreamableModule<FinalSynthesizerConfig> {
  readonly name = "FinalSynthesizer";
  readonly version = "0.4.0";
  private config: FinalSynthesizerConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<FinalSynthesizerConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;

    if (!trajectory) {
      return {
        data: { finalAnswer: "No trajectory available for synthesis" },
        metrics: { synthesized: false },
      };
    }

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("hera/synthesis", {
        query: trajectory.query,
        steps: trajectory.steps
          .map((s) => `${s.agent}: ${s.result.substring(0, this.config.maxStepChars)}`)
          .join("\n\n"),
      });

      const resp = await llm.invoke(messages);
      const answer = typeof resp.content === "string"
        ? resp.content
        : "Synthesis failed";

      trajectory.finalAnswer = answer;

      ctx.logger.info("FinalSynthesizer: Synthesized answer from trajectory");

      return {
        data: { finalAnswer: answer, trajectory },
        metrics: { synthesized: true },
      };
    } catch {
      const fallback = trajectory.finalAnswer ?? trajectory.steps.at(-1)?.result ?? "No answer";
      return {
        data: { finalAnswer: fallback, trajectory },
        metrics: { synthesized: false },
      };
    }
  }

  /**
   * Streaming variant: yields tokens during HERA trajectory synthesis.
   *
   * Uses LangChain's `.stream()` for real-time token output.
   * Falls back to non-streaming `.invoke()` if streaming fails.
   */
  async *processStream(
    input: ModuleInput<FinalSynthesizerConfig>,
    context: unknown,
  ): AsyncGenerator<StreamEvent, ModuleOutput, undefined> {
    const ctx = context as WorkflowContext;
    const trajectory = input.data.trajectory as AgentTrajectory | undefined;

    if (!trajectory) {
      return {
        data: { finalAnswer: "No trajectory available for synthesis" },
        metrics: { synthesized: false },
      };
    }

    try {
      const llm = ctx.getLLM();
      const { messages } = loadAndRender("hera/synthesis", {
        query: trajectory.query,
        steps: trajectory.steps
          .map((s) => `${s.agent}: ${s.result.substring(0, this.config.maxStepChars)}`)
          .join("\n\n"),
      });

      let answer = "";
      let tokenIndex = 0;

      try {
        const stream = await llm.stream(messages);

        for await (const chunk of stream) {
          const token = typeof chunk.content === "string" ? chunk.content : "";
          if (token) {
            answer += token;

            yield {
              type: "stage:progress" as const,
              stageId: "__current__",
              module: this.name,
              token,
              tokenIndex: tokenIndex++,
              timestamp: new Date().toISOString(),
            };
          }
        }
      } catch {
        // Streaming failed — fall back to invoke()
        if (!answer) {
          const resp = await llm.invoke(messages);
          answer = typeof resp.content === "string" ? resp.content : "Synthesis failed";
        }
      }

      trajectory.finalAnswer = answer;
      ctx.logger.info("FinalSynthesizer: Streamed synthesis from trajectory");

      return {
        data: { finalAnswer: answer, trajectory },
        metrics: { synthesized: true, tokensStreamed: tokenIndex },
      };
    } catch {
      const fallback = trajectory.finalAnswer ?? trajectory.steps.at(-1)?.result ?? "No answer";
      return {
        data: { finalAnswer: fallback, trajectory },
        metrics: { synthesized: false },
      };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
