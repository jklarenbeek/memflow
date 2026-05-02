/**
 * DelphiPanelModule — anonymous expert polling (Pattern F)
 *
 * Implements Delphi method: anonymous polling → statistical aggregation →
 * share results → re-poll → converge. Supports pluggable convergence
 * functions with built-in strategies (std_dev, interquartile_range, entropy).
 *
 * Reads:  query (question)
 * Writes: delphiPanelState, finalAnswer
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { emitPatternEvent } from "../emitPatternEvent.js";
import {
  PanelResponseSchema,
  AggregatedResultSchema,
  type PanelResponse,
  type AggregatedResult,
  type DelphiPanelState,
} from "../types.js";

// ---------------------------------------------------------------------------
// Convergence functions (pluggable with built-in defaults)
// ---------------------------------------------------------------------------

/** Convergence metric function: takes confidence values, returns score (lower = more converged) */
export type ConvergenceFn = (confidences: number[]) => number;

const BUILTIN_CONVERGENCE: Record<string, ConvergenceFn> = {
  std_dev: (values: number[]) => {
    if (values.length === 0) return 1;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  },
  interquartile_range: (values: number[]) => {
    if (values.length < 4) return BUILTIN_CONVERGENCE.std_dev(values);
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    return q3 - q1;
  },
  entropy: (values: number[]) => {
    if (values.length === 0) return 1;
    // Bin into 10 buckets for probability estimation
    const bins = new Array(10).fill(0);
    for (const v of values) bins[Math.min(Math.floor(v * 10), 9)]++;
    const total = values.length;
    let entropy = 0;
    for (const count of bins) {
      if (count > 0) {
        const p = count / total;
        entropy -= p * Math.log2(p);
      }
    }
    // Normalize to 0–1 range (max entropy for 10 bins is log2(10) ≈ 3.32)
    return entropy / Math.log2(10);
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PanelistSchema = z.object({
  id: z.string(),
  persona: z.string(),
  promptPack: z.string().optional(),
});

const ConfigSchema = z.object({
  panelSize: z.number().min(2).max(20).default(5),
  maxRounds: z.number().min(1).max(10).default(3),
  anonymize: z.boolean().default(true),
  convergenceMetric: z.string().default("std_dev"),
  convergenceThreshold: z.number().min(0).max(1).default(0.2),
  panelists: z.array(PanelistSchema).optional(),
});

type Config = z.infer<typeof ConfigSchema>;
type PanelistConfig = z.infer<typeof PanelistSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class DelphiPanelModule implements BaseModule<Config> {
  readonly name = "DelphiPanelModule";
  readonly version = "0.5.1";
  private config: Config;

  /** Custom convergence functions registered at runtime */
  private static customConvergence = new Map<string, ConvergenceFn>();

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  /**
   * Register a custom convergence function.
   * @param name - Metric name (used in config.convergenceMetric)
   * @param fn - Function that takes confidence values and returns convergence score
   */
  static registerConvergence(name: string, fn: ConvergenceFn): void {
    DelphiPanelModule.customConvergence.set(name, fn);
  }

  private getConvergenceFn(): ConvergenceFn {
    const name = this.config.convergenceMetric;
    return (
      DelphiPanelModule.customConvergence.get(name) ??
      BUILTIN_CONVERGENCE[name] ??
      BUILTIN_CONVERGENCE.std_dev
    );
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const inputConfig = Object.keys(input.config).length > 0 ? ConfigSchema.parse(input.config) : {};
    const mergedConfig = { ...this.config, ...inputConfig };
    const question = (input.data.query as string) ?? "";

    // Build panelist roster
    const panelists = mergedConfig.panelists ?? this.generateDefaultPanelists(mergedConfig.panelSize);

    const state: DelphiPanelState = {
      question, rounds: [], currentRound: 0, converged: false,
    };

    const convergeFn = this.getConvergenceFn();
    ctx.logger.info(`DelphiPanelModule: Starting with ${panelists.length} panelists, metric=${mergedConfig.convergenceMetric}`);

    for (let round = 1; round <= mergedConfig.maxRounds; round++) {
      state.currentRound = round;
      ctx.logger.info(`DelphiPanelModule: Round ${round}/${mergedConfig.maxRounds}`);

      // Emit poll start event
      emitPatternEvent(context, "delphi_panel", "delphi:poll_start", this.name, {
        round,
        panelSize: panelists.length,
      });

      // Previous round context (anonymized if configured)
      const prevContext = state.rounds.length > 0
        ? this.buildPreviousRoundContext(state.rounds[state.rounds.length - 1], mergedConfig.anonymize)
        : "";

      // Poll all panelists
      const responses: PanelResponse[] = [];
      for (const panelist of panelists) {
        const resp = await this.pollPanelist(ctx, question, panelist, round, prevContext, mergedConfig.anonymize);
        responses.push(resp);

        // Emit response event
        emitPatternEvent(context, "delphi_panel", "delphi:response", this.name, {
          panelistId: resp.panelistId,
          confidence: resp.confidence,
          round,
        });
      }

      // Aggregate
      const aggregated = this.aggregate(responses, round, convergeFn);
      state.rounds.push(aggregated);

      ctx.logger.info(
        `DelphiPanelModule: Round ${round} — mean=${aggregated.mean.toFixed(2)}, ` +
        `stdDev=${aggregated.stdDev.toFixed(3)}, convergence=${aggregated.convergenceScore.toFixed(3)}`,
      );

      // Check convergence
      if (aggregated.convergenceScore <= mergedConfig.convergenceThreshold) {
        state.converged = true;
        state.finalAggregation = aggregated;
        ctx.logger.info(`DelphiPanelModule: Converged at round ${round}`);

        // Emit converged event
        emitPatternEvent(context, "delphi_panel", "delphi:converged", this.name, {
          round,
          convergenceScore: aggregated.convergenceScore,
          metric: mergedConfig.convergenceMetric,
        });

        break;
      }
    }

    if (!state.converged) {
      state.finalAggregation = state.rounds[state.rounds.length - 1];
      ctx.logger.info("DelphiPanelModule: Max rounds reached without convergence");
    }

    // Generate final synthesis
    const finalAnswer = await this.synthesize(ctx, question, state);

    await this.persistSession(ctx, state);

    return {
      data: { delphiPanelState: state, finalAnswer },
      metrics: {
        delphiRounds: state.currentRound,
        panelSize: panelists.length,
        converged: state.converged,
        finalConvergence: state.finalAggregation?.convergenceScore ?? 1,
        convergenceMetric: mergedConfig.convergenceMetric,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private async pollPanelist(
    ctx: WorkflowContext, question: string, panelist: PanelistConfig,
    round: number, prevContext: string, anonymize: boolean,
  ): Promise<PanelResponse> {
    const llm = ctx.getLLM();

    const prompt = [
      {
        type: "system" as const,
        content:
          `You are an expert panelist "${panelist.persona}" (ID: "${panelist.id}"). ` +
          `Provide your honest assessment. Respond with JSON:\n` +
          `{"response": "your response", "confidence": 0.0-1.0, "reasoning": "your reasoning"}`,
      },
      {
        type: "user" as const,
        content:
          `Question: ${question}\nRound: ${round}\n` +
          (prevContext ? `\nPrevious round results (anonymized):\n${prevContext}\n` : "") +
          `\nProvide your assessment.`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      return PanelResponseSchema.parse({
        panelistId: anonymize ? `panelist_${round}_${panelist.id.substring(0, 4)}` : panelist.id,
        response: (parsed.response as string) ?? "No response",
        confidence: (parsed.confidence as number) ?? 0.5,
        reasoning: (parsed.reasoning as string) ?? "No reasoning provided",
        round,
      });
    } catch (err) {
      ctx.logger.warn(`DelphiPanelModule: Panelist ${panelist.id} failed: ${(err as Error).message}`);
      return {
        panelistId: anonymize ? `panelist_${round}_anon` : panelist.id,
        response: "Unable to generate response",
        confidence: 0.5,
        reasoning: "Response generation failed",
        round,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Aggregation
  // -----------------------------------------------------------------------

  private aggregate(responses: PanelResponse[], round: number, convergeFn: ConvergenceFn): AggregatedResult {
    const confidences = responses.map((r) => r.confidence);
    const mean = confidences.reduce((s, v) => s + v, 0) / confidences.length;
    const variance = confidences.reduce((s, v) => s + (v - mean) ** 2, 0) / confidences.length;
    const stdDev = Math.sqrt(variance);
    const sorted = [...confidences].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

    return AggregatedResultSchema.parse({
      round, responses, mean, stdDev, median,
      convergenceScore: convergeFn(confidences),
    });
  }

  private buildPreviousRoundContext(prev: AggregatedResult, anonymize: boolean): string {
    const lines = [
      `Summary: mean=${prev.mean.toFixed(2)}, stdDev=${prev.stdDev.toFixed(3)}, median=${prev.median.toFixed(2)}`,
    ];
    for (const r of prev.responses) {
      const id = anonymize ? "Anonymous" : r.panelistId;
      lines.push(`[${id}] conf=${r.confidence.toFixed(2)}: ${r.response.substring(0, 200)}`);
    }
    return lines.join("\n");
  }

  private generateDefaultPanelists(size: number): PanelistConfig[] {
    return Array.from({ length: size }, (_, i) => ({
      id: `expert_${i + 1}`,
      persona: `domain_expert_${i + 1}`,
    }));
  }

  // -----------------------------------------------------------------------
  // Synthesis
  // -----------------------------------------------------------------------

  private async synthesize(ctx: WorkflowContext, question: string, state: DelphiPanelState): Promise<string> {
    if (!state.finalAggregation) return "No aggregation available";
    const llm = ctx.getLLM();

    const responseSummary = state.finalAggregation.responses
      .map((r) => `[conf=${r.confidence.toFixed(2)}]: ${r.response.substring(0, 300)}`)
      .join("\n");

    try {
      const resp = await llm.invoke([
        { type: "system" as const, content: "Synthesize the Delphi panel results into a final consensus statement." },
        { type: "user" as const, content: `Question: ${question}\n\nPanel responses (round ${state.finalAggregation.round}):\n${responseSummary}\n\nMean confidence: ${state.finalAggregation.mean.toFixed(2)}` },
      ]);
      return typeof resp.content === "string" ? resp.content : "Synthesis failed";
    } catch {
      return `Panel consensus (${state.finalAggregation.responses.length} experts, mean conf: ${state.finalAggregation.mean.toFixed(2)})`;
    }
  }

  // -----------------------------------------------------------------------
  // KG persistence
  // -----------------------------------------------------------------------

  private async persistSession(ctx: WorkflowContext, state: DelphiPanelState): Promise<void> {
    try {
      await ctx.memgraph.query(
        `CREATE (dp:DelphiSession {
           id: $id, rounds: $rounds, converged: $converged,
           finalConvergence: $convergence, timestamp: $timestamp
         })`,
        {
          id: `delphi-${uuidv4()}`, rounds: state.currentRound,
          converged: state.converged,
          convergence: state.finalAggregation?.convergenceScore ?? 1,
          timestamp: new Date().toISOString(),
        },
      );
    } catch (err) {
      ctx.logger.warn(`DelphiPanelModule: KG persistence failed: ${(err as Error).message}`);
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
