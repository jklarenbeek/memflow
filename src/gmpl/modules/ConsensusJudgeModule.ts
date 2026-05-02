/**
 * ConsensusJudgeModule — evaluate debate convergence (Pattern A helper)
 *
 * Reads:  debateState
 * Writes: consensusReport
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { ConsensusReportSchema, type DebateState, type ConsensusReport } from "../types.js";

const ConfigSchema = z.object({
  convergenceThreshold: z.number().min(0).max(1).default(0.7),
  maxContextChars: z.number().default(4000),
});
type Config = z.infer<typeof ConfigSchema>;

export class ConsensusJudgeModule implements BaseModule<Config> {
  readonly name = "ConsensusJudge";
  readonly version = "0.5.1";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const debateState = input.data.debateState as DebateState | undefined;

    if (!debateState || debateState.positions.length === 0) {
      return { data: {}, metrics: { judged: false } };
    }

    const report = await this.evaluate(ctx, debateState);
    ctx.logger.info(`ConsensusJudge: convergence=${report.convergenceScore.toFixed(2)}, action=${report.action}`);

    return {
      data: { consensusReport: report },
      metrics: { judged: true, convergenceScore: report.convergenceScore, action: report.action },
    };
  }

  private async evaluate(ctx: WorkflowContext, state: DebateState): Promise<ConsensusReport> {
    const llm = ctx.getLLM();
    const latestRound = state.currentRound;
    const latestPositions = state.positions.filter((p) => p.round === latestRound);

    const positionSummary = latestPositions
      .map((p) => `[${p.roleId}] ${p.stance} (confidence: ${p.confidence})`)
      .join("\n")
      .substring(0, this.config.maxContextChars);

    const prompt = [
      { type: "system" as const, content: "You are a debate judge. Respond with JSON: {\"verdict\": \"...\", \"convergence_score\": 0.0-1.0, \"key_findings\": [\"...\"], \"dissent\": [\"...\"], \"action\": \"accept|reject|continue|escalate\"}" },
      { type: "user" as const, content: `Round ${latestRound}:\n${positionSummary}\nThreshold: ${this.config.convergenceThreshold}` },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      return ConsensusReportSchema.parse({
        verdict: (parsed.verdict as string) ?? "No verdict",
        convergenceScore: (parsed.convergence_score as number) ?? 0.5,
        keyFindings: (parsed.key_findings as string[]) ?? [],
        dissent: (parsed.dissent as string[]) ?? [],
        action: (parsed.action as string) ?? "continue",
        roundsCompleted: latestRound,
      });
    } catch {
      const avgConf = latestPositions.reduce((s, p) => s + p.confidence, 0) / (latestPositions.length || 1);
      return {
        verdict: "Automated fallback assessment",
        convergenceScore: avgConf,
        keyFindings: [],
        dissent: latestPositions.map((p) => p.stance),
        action: avgConf >= this.config.convergenceThreshold ? "accept" : "continue",
        roundsCompleted: latestRound,
      };
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
