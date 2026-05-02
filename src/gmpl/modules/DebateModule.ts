/**
 * DebateModule — Structured opposing-view debate (Pattern A)
 *
 * Implements the Structured Debate pattern inspired by TradingAgents
 * (arXiv:2412.20138v7). Manages multi-round debates between opposing
 * role agents with evidence citations, history injection, and configurable
 * termination conditions.
 *
 * Reads:  query
 * Writes: debateState, consensusReport, finalAnswer
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { emitPatternEvent } from "../emitPatternEvent.js";
import {
  DebatePositionSchema,
  DebateStateSchema,
  ConsensusReportSchema,
  type DebateState,
  type DebatePosition,
  type ConsensusReport,
} from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DebateRoleSchema = z.object({
  id: z.string(),
  persona: z.string(),
  promptPack: z.string().optional(),
});

const TerminationSchema = z.object({
  type: z.enum(["max_rounds", "consensus_threshold", "judge_decision"]),
  judgeRole: z.string().optional(),
  consensusThreshold: z.number().min(0).max(1).optional(),
});

const ConfigSchema = z.object({
  roles: z.array(DebateRoleSchema).min(2),
  maxRounds: z.number().min(1).max(10).default(3),
  termination: TerminationSchema.default({ type: "max_rounds" }),
  evidenceRetrieval: z.enum(["hybrid", "vector", "graph", "none"]).default("none"),
  historyInjection: z.boolean().default(true),
});

type DebateConfig = z.infer<typeof ConfigSchema>;
type DebateRoleConfig = z.infer<typeof DebateRoleSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class DebateModule implements BaseModule<DebateConfig> {
  readonly name = "DebateModule";
  readonly version = "0.5.1";
  private config: DebateConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<DebateConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const inputConfig = Object.keys(input.config).length > 0 ? ConfigSchema.parse(input.config) : {};
    const mergedConfig = { ...this.config, ...inputConfig };
    const query = (input.data.query as string) ?? "";

    const state: DebateState = {
      positions: [],
      currentRound: 0,
      concluded: false,
    };

    ctx.logger.info(`DebateModule: Starting debate with ${mergedConfig.roles.length} roles, max ${mergedConfig.maxRounds} rounds`);

    for (let round = 1; round <= mergedConfig.maxRounds; round++) {
      state.currentRound = round;

      ctx.logger.info(`DebateModule: Round ${round}/${mergedConfig.maxRounds}`);

      // Emit pattern:event for observability
      emitPatternEvent(context, "structured_debate", "debate:round_start", this.name, {
        round,
        maxRounds: mergedConfig.maxRounds,
        roles: mergedConfig.roles.map((r) => r.id),
      });

      // Collect positions from all roles for this round
      const roundPositions: DebatePosition[] = [];

      for (const role of mergedConfig.roles) {
        const position = await this.generatePosition(
          ctx,
          query,
          role,
          round,
          state.positions,
          mergedConfig,
        );
        roundPositions.push(position);
        state.positions.push(position);

        // Emit position event
        emitPatternEvent(context, "structured_debate", "debate:position", this.name, {
          round,
          roleId: role.id,
          stance: position.stance,
          confidence: position.confidence,
        });
      }

      // Check termination
      const shouldConclude = await this.checkTermination(
        ctx,
        mergedConfig,
        roundPositions,
        round,
        query,
      );

      if (shouldConclude) {
        state.concluded = true;
        state.consensusReport = shouldConclude;
        ctx.logger.info(`DebateModule: Debate concluded at round ${round} — ${shouldConclude.action}`);
        break;
      }
    }

    // If we exhausted rounds without explicit conclusion, generate final report
    if (!state.concluded) {
      state.concluded = true;
      state.consensusReport = await this.generateConsensusReport(
        ctx,
        query,
        state.positions,
        state.currentRound,
      );
      ctx.logger.info("DebateModule: Max rounds reached — generating final consensus");
    }

    // Persist debate session to KG
    await this.persistDebateSession(ctx, query, state);

    return {
      data: {
        debateState: state,
        consensusReport: state.consensusReport,
        finalAnswer: state.consensusReport?.verdict,
      },
      metrics: {
        debateRounds: state.currentRound,
        totalPositions: state.positions.length,
        convergenceScore: state.consensusReport?.convergenceScore ?? 0,
        action: state.consensusReport?.action ?? "unknown",
      },
    };
  }

  // -----------------------------------------------------------------------
  // Position generation
  // -----------------------------------------------------------------------

  private async generatePosition(
    ctx: WorkflowContext,
    query: string,
    role: DebateRoleConfig,
    round: number,
    history: DebatePosition[],
    config: DebateConfig,
  ): Promise<DebatePosition> {
    const llm = ctx.getLLM();

    // Build history context for this role
    const historyContext = config.historyInjection
      ? this.buildHistoryContext(history, role.id, round)
      : "";

    const opposingPositions = history
      .filter((p) => p.roleId !== role.id && p.round === round - 1)
      .map((p) => `[${p.roleId}]: ${p.stance}`)
      .join("\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          `You are a debate participant with persona "${role.persona}". ` +
          `Your role ID is "${role.id}". Respond with JSON only:\n` +
          `{"stance": "your argued position", "evidence": ["evidence1", "evidence2"], "confidence": 0.0-1.0, "rebuttal": "optional rebuttal to opposing views"}`,
      },
      {
        type: "user" as const,
        content:
          `Topic: ${query}\n` +
          `Round: ${round}\n` +
          (opposingPositions ? `\nOpposing positions from previous round:\n${opposingPositions}\n` : "") +
          (historyContext ? `\nDebate history:\n${historyContext}\n` : "") +
          `\nProvide your position for this round.`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      return DebatePositionSchema.parse({
        roleId: role.id,
        stance: (parsed.stance as string) ?? "No position stated",
        evidence: (parsed.evidence as string[]) ?? [],
        confidence: (parsed.confidence as number) ?? 0.5,
        rebuttal: parsed.rebuttal as string | undefined,
        round,
      });
    } catch (err) {
      ctx.logger.warn(`DebateModule: Position generation failed for ${role.id}: ${(err as Error).message}`);
      return {
        roleId: role.id,
        stance: "Unable to generate position",
        evidence: [],
        confidence: 0.3,
        round,
      };
    }
  }

  private buildHistoryContext(
    history: DebatePosition[],
    currentRoleId: string,
    currentRound: number,
  ): string {
    return history
      .filter((p) => p.round < currentRound)
      .map((p) => `[Round ${p.round}][${p.roleId}] ${p.stance} (confidence: ${p.confidence})`)
      .join("\n");
  }

  // -----------------------------------------------------------------------
  // Termination
  // -----------------------------------------------------------------------

  private async checkTermination(
    ctx: WorkflowContext,
    config: DebateConfig,
    roundPositions: DebatePosition[],
    round: number,
    query: string,
  ): Promise<ConsensusReport | null> {
    if (config.termination.type === "max_rounds" && round >= config.maxRounds) {
      return null; // Let the outer loop handle max_rounds conclusion
    }

    if (config.termination.type === "consensus_threshold") {
      const avgConfidence =
        roundPositions.reduce((sum, p) => sum + p.confidence, 0) / roundPositions.length;
      const threshold = config.termination.consensusThreshold ?? 0.8;

      // Check if all positions are converging (high confidence + similar stances)
      if (avgConfidence >= threshold) {
        return {
          verdict: roundPositions[0].stance,
          convergenceScore: avgConfidence,
          keyFindings: roundPositions.map((p) => p.stance),
          dissent: [],
          action: "accept",
          roundsCompleted: round,
        };
      }
    }

    if (config.termination.type === "judge_decision") {
      return this.getJudgeDecision(ctx, query, roundPositions, round);
    }

    return null;
  }

  private async getJudgeDecision(
    ctx: WorkflowContext,
    query: string,
    positions: DebatePosition[],
    round: number,
  ): Promise<ConsensusReport | null> {
    const llm = ctx.getLLM();

    const positionSummary = positions
      .map((p) => `[${p.roleId}] ${p.stance} (confidence: ${p.confidence})`)
      .join("\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          "You are a debate judge. Evaluate the positions and decide whether to conclude or continue. " +
          'Respond with JSON only:\n{"should_conclude": true/false, "verdict": "summary", "convergence_score": 0.0-1.0, ' +
          '"key_findings": ["..."], "dissent": ["..."], "action": "accept|reject|continue|escalate"}',
      },
      {
        type: "user" as const,
        content: `Topic: ${query}\nRound: ${round}\n\nPositions:\n${positionSummary}\n\nShould this debate conclude?`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      if (parsed.should_conclude) {
        return ConsensusReportSchema.parse({
          verdict: (parsed.verdict as string) ?? "No verdict",
          convergenceScore: (parsed.convergence_score as number) ?? 0.5,
          keyFindings: (parsed.key_findings as string[]) ?? [],
          dissent: (parsed.dissent as string[]) ?? [],
          action: (parsed.action as string) ?? "accept",
          roundsCompleted: round,
        });
      }
    } catch (err) {
      ctx.logger.warn(`DebateModule: Judge decision failed: ${(err as Error).message}`);
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Final consensus
  // -----------------------------------------------------------------------

  private async generateConsensusReport(
    ctx: WorkflowContext,
    query: string,
    positions: DebatePosition[],
    roundsCompleted: number,
  ): Promise<ConsensusReport> {
    const llm = ctx.getLLM();

    const positionSummary = positions
      .map((p) => `[Round ${p.round}][${p.roleId}] ${p.stance}`)
      .join("\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          "You are a debate synthesizer. Produce a final consensus report from the debate. " +
          'Respond with JSON only:\n{"verdict": "final summary", "convergence_score": 0.0-1.0, ' +
          '"key_findings": ["..."], "dissent": ["..."], "action": "accept|reject|continue|escalate"}',
      },
      {
        type: "user" as const,
        content: `Topic: ${query}\n\nAll positions across ${roundsCompleted} rounds:\n${positionSummary}`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      return ConsensusReportSchema.parse({
        verdict: (parsed.verdict as string) ?? "No consensus reached",
        convergenceScore: (parsed.convergence_score as number) ?? 0.5,
        keyFindings: (parsed.key_findings as string[]) ?? [],
        dissent: (parsed.dissent as string[]) ?? [],
        action: (parsed.action as string) ?? "accept",
        roundsCompleted,
      });
    } catch {
      return {
        verdict: "Unable to generate consensus report",
        convergenceScore: 0,
        keyFindings: [],
        dissent: positions.map((p) => p.stance),
        action: "escalate",
        roundsCompleted,
      };
    }
  }

  // -----------------------------------------------------------------------
  // KG persistence
  // -----------------------------------------------------------------------

  private async persistDebateSession(
    ctx: WorkflowContext,
    query: string,
    state: DebateState,
  ): Promise<void> {
    try {
      const sessionId = `debate-${uuidv4()}`;
      await ctx.memgraph.query(
        `CREATE (d:DebateSession {
           id: $id,
           query: $query,
           rounds: $rounds,
           concluded: $concluded,
           verdict: $verdict,
           convergenceScore: $convergenceScore,
           timestamp: $timestamp
         })`,
        {
          id: sessionId,
          query,
          rounds: state.currentRound,
          concluded: state.concluded,
          verdict: state.consensusReport?.verdict ?? "",
          convergenceScore: state.consensusReport?.convergenceScore ?? 0,
          timestamp: new Date().toISOString(),
        },
      );
    } catch (err) {
      ctx.logger.warn(`DebateModule: KG persistence failed: ${(err as Error).message}`);
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }

}
