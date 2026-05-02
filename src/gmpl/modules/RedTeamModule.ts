/**
 * RedTeamModule — adversarial stress-testing (Pattern E)
 *
 * Generates a proposal → red team attacks (freeform LLM, seeded by
 * strategy strings for traceability) → blue team defends → judge
 * evaluates resilience. Repeats until resilience threshold is met
 * or max rounds exhausted.
 *
 * Reads:  query (proposal)
 * Writes: redTeamState, finalAnswer
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { emitPatternEvent } from "../emitPatternEvent.js";
import {
  AttackSchema,
  DefenseSchema,
  ResilienceReportSchema,
  type Attack,
  type Defense,
  type ResilienceReport,
  type RedTeamState,
} from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TeamMemberSchema = z.object({
  id: z.string(),
  persona: z.string(),
});

const ConfigSchema = z.object({
  attackStrategies: z
    .array(z.string())
    .default(["adversarial_reframing", "edge_case_injection", "assumption_challenge"]),
  redTeam: z.array(TeamMemberSchema).min(1),
  blueTeam: z.array(TeamMemberSchema).min(1),
  maxRounds: z.number().min(1).max(10).default(3),
  resilienceThreshold: z.number().min(0).max(1).default(0.7),
});

type Config = z.infer<typeof ConfigSchema>;
type TeamMember = z.infer<typeof TeamMemberSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class RedTeamModule implements BaseModule<Config> {
  readonly name = "RedTeamModule";
  readonly version = "0.5.1";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const inputConfig = Object.keys(input.config).length > 0 ? ConfigSchema.parse(input.config) : {};
    const mergedConfig = { ...this.config, ...inputConfig };
    const proposal = (input.data.query as string) ?? "";

    const state: RedTeamState = {
      proposal, attacks: [], defenses: [], currentRound: 0, concluded: false,
    };

    ctx.logger.info(
      `RedTeamModule: Starting with ${mergedConfig.redTeam.length} attackers, ` +
      `${mergedConfig.blueTeam.length} defenders, max ${mergedConfig.maxRounds} rounds`,
    );

    for (let round = 1; round <= mergedConfig.maxRounds; round++) {
      state.currentRound = round;
      ctx.logger.info(`RedTeamModule: Round ${round}/${mergedConfig.maxRounds}`);

      // Red team attacks
      const roundAttacks: Attack[] = [];
      for (const attacker of mergedConfig.redTeam) {
        const strategy = mergedConfig.attackStrategies[(round - 1) % mergedConfig.attackStrategies.length];
        const attack = await this.generateAttack(ctx, proposal, attacker, strategy, round, state.defenses);
        roundAttacks.push(attack);
        state.attacks.push(attack);

        // Emit attack event
        emitPatternEvent(context, "red_team", "redteam:attack", this.name, {
          attackerId: attacker.id,
          strategy,
          round,
        });
      }

      // Blue team defends
      const roundDefenses: Defense[] = [];
      for (const defender of mergedConfig.blueTeam) {
        const defense = await this.generateDefense(ctx, proposal, defender, roundAttacks, round);
        roundDefenses.push(defense);
        state.defenses.push(defense);

        // Emit defense event
        emitPatternEvent(context, "red_team", "redteam:defense", this.name, {
          defenderId: defender.id,
          confidence: defense.confidence,
          round,
        });
      }

      // Judge evaluates
      const report = await this.evaluateResilience(ctx, proposal, roundAttacks, roundDefenses, round);
      if (report && report.resilienceScore >= mergedConfig.resilienceThreshold) {
        state.concluded = true;
        state.resilienceReport = report;

        // Emit resilience judged event
        emitPatternEvent(context, "red_team", "redteam:resilience_judged", this.name, {
          resilienceScore: report.resilienceScore,
          action: report.action,
          round,
        });

        ctx.logger.info(`RedTeamModule: Concluded at round ${round} — resilience ${report.resilienceScore.toFixed(2)}`);
        break;
      }
    }

    if (!state.concluded) {
      state.concluded = true;
      state.resilienceReport = await this.generateFinalReport(ctx, state);
      ctx.logger.info("RedTeamModule: Max rounds reached — generating final resilience report");
    }

    await this.persistSession(ctx, state);

    return {
      data: { redTeamState: state, finalAnswer: state.resilienceReport?.verdict },
      metrics: {
        redTeamRounds: state.currentRound,
        totalAttacks: state.attacks.length,
        totalDefenses: state.defenses.length,
        resilienceScore: state.resilienceReport?.resilienceScore ?? 0,
        action: state.resilienceReport?.action ?? "unknown",
      },
    };
  }

  // -----------------------------------------------------------------------
  // Attack generation (freeform LLM, seeded by strategy)
  // -----------------------------------------------------------------------

  private async generateAttack(
    ctx: WorkflowContext, proposal: string, attacker: TeamMember,
    strategy: string, round: number, previousDefenses: Defense[],
  ): Promise<Attack> {
    const llm = ctx.getLLM();
    const defenseCtx = previousDefenses
      .filter((d) => d.round === round - 1)
      .map((d) => `[${d.defenderId}]: ${d.defense}`)
      .join("\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          `You are a red team attacker "${attacker.persona}" (ID: "${attacker.id}"). ` +
          `Strategy seed: "${strategy}". Craft a freeform attack. Respond with JSON:\n` +
          `{"attack": "your attack", "target_weakness": "identified weakness"}`,
      },
      {
        type: "user" as const,
        content:
          `Proposal: ${proposal.substring(0, 2000)}\nRound: ${round}\nStrategy: ${strategy}\n` +
          (defenseCtx ? `\nPrevious defenses:\n${defenseCtx}\n` : "") +
          `\nGenerate your attack.`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
      return AttackSchema.parse({
        attackerId: attacker.id, strategy,
        attack: (parsed.attack as string) ?? "No attack generated",
        targetWeakness: (parsed.target_weakness as string) ?? "Unknown", round,
      });
    } catch (err) {
      ctx.logger.warn(`RedTeamModule: Attack failed for ${attacker.id}: ${(err as Error).message}`);
      return { attackerId: attacker.id, strategy, attack: "Unable to generate attack", targetWeakness: "Unknown", round };
    }
  }

  // -----------------------------------------------------------------------
  // Defense generation
  // -----------------------------------------------------------------------

  private async generateDefense(
    ctx: WorkflowContext, proposal: string, defender: TeamMember,
    attacks: Attack[], round: number,
  ): Promise<Defense> {
    const llm = ctx.getLLM();
    const attackSummary = attacks.map((a) => `[${a.attackerId}] (${a.strategy}): ${a.attack}`).join("\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          `You are a blue team defender "${defender.persona}" (ID: "${defender.id}"). ` +
          `Respond with JSON:\n{"defense": "...", "mitigations": ["..."], "confidence": 0.0-1.0}`,
      },
      {
        type: "user" as const,
        content: `Proposal: ${proposal.substring(0, 1500)}\nRound: ${round}\n\nAttacks:\n${attackSummary}\n\nDefend.`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
      return DefenseSchema.parse({
        defenderId: defender.id,
        defense: (parsed.defense as string) ?? "No defense provided",
        mitigations: (parsed.mitigations as string[]) ?? [],
        confidence: (parsed.confidence as number) ?? 0.5, round,
      });
    } catch (err) {
      ctx.logger.warn(`RedTeamModule: Defense failed for ${defender.id}: ${(err as Error).message}`);
      return { defenderId: defender.id, defense: "Unable to generate defense", mitigations: [], confidence: 0.3, round };
    }
  }

  // -----------------------------------------------------------------------
  // Resilience evaluation
  // -----------------------------------------------------------------------

  private async evaluateResilience(
    ctx: WorkflowContext, proposal: string,
    attacks: Attack[], defenses: Defense[], round: number,
  ): Promise<ResilienceReport | null> {
    const llm = ctx.getLLM();
    const aSummary = attacks.map((a) => `[${a.attackerId}] ${a.attack}`).join("\n");
    const dSummary = defenses.map((d) => `[${d.defenderId}] ${d.defense} (conf: ${d.confidence})`).join("\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          "You are a resilience judge. Respond with JSON:\n" +
          '{"verdict": "...", "resilience_score": 0.0-1.0, "vulnerabilities": ["..."], "strengths": ["..."], "action": "accept|reject|strengthen|escalate"}',
      },
      {
        type: "user" as const,
        content: `Proposal: ${proposal.substring(0, 1000)}\nRound: ${round}\n\nAttacks:\n${aSummary}\n\nDefenses:\n${dSummary}\n\nEvaluate.`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
      return ResilienceReportSchema.parse({
        verdict: (parsed.verdict as string) ?? "No verdict",
        resilienceScore: (parsed.resilience_score as number) ?? 0.5,
        vulnerabilities: (parsed.vulnerabilities as string[]) ?? [],
        strengths: (parsed.strengths as string[]) ?? [],
        action: (parsed.action as string) ?? "strengthen",
        roundsCompleted: round,
      });
    } catch (err) {
      ctx.logger.warn(`RedTeamModule: Resilience eval failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async generateFinalReport(ctx: WorkflowContext, state: RedTeamState): Promise<ResilienceReport> {
    const lastRoundAttacks = state.attacks.filter((a) => a.round === state.currentRound);
    const lastRoundDefenses = state.defenses.filter((d) => d.round === state.currentRound);
    const report = await this.evaluateResilience(ctx, state.proposal, lastRoundAttacks, lastRoundDefenses, state.currentRound);
    if (report) return report;

    const avgConf = state.defenses.length > 0
      ? state.defenses.reduce((s, d) => s + d.confidence, 0) / state.defenses.length : 0;
    return {
      verdict: "Red team exercise completed without definitive conclusion",
      resilienceScore: avgConf,
      vulnerabilities: [...new Set(state.attacks.map((a) => a.targetWeakness))],
      strengths: [...new Set(state.defenses.flatMap((d) => d.mitigations))],
      action: avgConf >= 0.7 ? "accept" : "strengthen",
      roundsCompleted: state.currentRound,
    };
  }

  // -----------------------------------------------------------------------
  // KG persistence
  // -----------------------------------------------------------------------

  private async persistSession(ctx: WorkflowContext, state: RedTeamState): Promise<void> {
    try {
      await ctx.memgraph.query(
        `CREATE (rt:RedTeamSession {
           id: $id, rounds: $rounds, concluded: $concluded,
           resilienceScore: $resilienceScore, verdict: $verdict, timestamp: $timestamp
         })`,
        {
          id: `redteam-${uuidv4()}`, rounds: state.currentRound, concluded: state.concluded,
          resilienceScore: state.resilienceReport?.resilienceScore ?? 0,
          verdict: state.resilienceReport?.verdict ?? "", timestamp: new Date().toISOString(),
        },
      );
    } catch (err) {
      ctx.logger.warn(`RedTeamModule: KG persistence failed: ${(err as Error).message}`);
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
