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
  BaseModule,
  ModuleInput,
  ModuleOutput,
  AgentTrajectory,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Max characters per step result to include in synthesis prompt */
  maxStepChars: z.number().default(400),
});

type FinalSynthesizerConfig = z.infer<typeof ConfigSchema>;

export class FinalSynthesizerModule implements BaseModule<FinalSynthesizerConfig> {
  readonly name = "FinalSynthesizer";
  readonly version = "0.2.0";
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

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
