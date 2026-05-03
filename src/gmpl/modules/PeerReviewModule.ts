/**
 * PeerReviewModule — iterative peer review cycle (Pattern D)
 *
 * Implements a structured review loop: submit draft → N reviewers provide
 * feedback → author revises → repeat until accepted or max cycles reached.
 *
 * Reads:  query (draft content)
 * Writes: peerReviewState, finalAnswer
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { emitPatternEvent } from "../emitPatternEvent.js";
import {
  ReviewFeedbackSchema,
  PeerReviewStateSchema,
  type ReviewFeedback,
  type PeerReviewState,
  type ReviewCycle,
} from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ReviewerSchema = z.object({
  id: z.string(),
  persona: z.string(),
  promptPack: z.string().optional(),
});

const ConfigSchema = z.object({
  reviewers: z.array(ReviewerSchema).min(1),
  maxCycles: z.number().min(1).max(10).default(3),
  acceptanceThreshold: z.number().min(0).max(1).default(0.7),
  revisionModel: z.string().optional(),
});

type Config = z.infer<typeof ConfigSchema>;
type ReviewerConfig = z.infer<typeof ReviewerSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class PeerReviewModule implements BaseModule<Config> {
  readonly name = "PeerReviewModule";
  readonly version = "0.5.1";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<Config>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const inputConfig = Object.keys(input.config).length > 0 ? ConfigSchema.parse(input.config) : {};
    const mergedConfig = { ...this.config, ...inputConfig };
    const draft = (input.data.query as string) ?? "";

    const state: PeerReviewState = {
      draft,
      cycles: [],
      currentCycle: 0,
      accepted: false,
    };

    ctx.logger.info(`PeerReviewModule: Starting review with ${mergedConfig.reviewers.length} reviewers, max ${mergedConfig.maxCycles} cycles`);

    for (let cycle = 1; cycle <= mergedConfig.maxCycles; cycle++) {
      state.currentCycle = cycle;

      ctx.logger.info(`PeerReviewModule: Cycle ${cycle}/${mergedConfig.maxCycles}`);

      // Emit cycle start event
      emitPatternEvent(context, "peer_review", "review:cycle_start", this.name, {
        cycle,
        maxCycles: mergedConfig.maxCycles,
        reviewerCount: mergedConfig.reviewers.length,
      });

      // Collect feedback from all reviewers
      const feedback: ReviewFeedback[] = [];
      for (const reviewer of mergedConfig.reviewers) {
        const fb = await this.getReviewerFeedback(ctx, state.draft, reviewer, cycle);
        feedback.push(fb);

        // Emit assessment event
        emitPatternEvent(context, "peer_review", "review:assessment", this.name, {
          reviewerId: reviewer.id,
          assessment: fb.assessment,
          cycle,
        });
      }

      const reviewCycle: ReviewCycle = {
        cycle,
        draft: state.draft,
        feedback,
        accepted: false,
      };

      // Check acceptance
      const acceptCount = feedback.filter((f) => f.assessment === "accept").length;
      const acceptRatio = acceptCount / feedback.length;

      if (acceptRatio >= mergedConfig.acceptanceThreshold) {
        reviewCycle.accepted = true;
        state.accepted = true;
        state.cycles.push(reviewCycle);
        ctx.logger.info(`PeerReviewModule: Draft accepted at cycle ${cycle} (${(acceptRatio * 100).toFixed(0)}% acceptance)`);
        break;
      }

      state.cycles.push(reviewCycle);

      // Revise draft unless this is the last cycle
      if (cycle < mergedConfig.maxCycles) {
        state.draft = await this.reviseDraft(ctx, state.draft, feedback, mergedConfig);
        ctx.logger.info(`PeerReviewModule: Draft revised for cycle ${cycle + 1}`);

        // Emit revision event
        emitPatternEvent(context, "peer_review", "review:revision", this.name, {
          cycle,
          accepted: false,
        });
      }
    }

    if (!state.accepted) {
      ctx.logger.info("PeerReviewModule: Max cycles reached without full acceptance");
    }

    // Persist review session to KG
    await this.persistReviewSession(ctx, state);

    return {
      data: {
        peerReviewState: state,
        finalAnswer: state.draft,
      },
      metrics: {
        _patternId: "peer_review",
        reviewCycles: state.currentCycle,
        accepted: state.accepted,
        totalFeedback: state.cycles.reduce((s, c) => s + c.feedback.length, 0),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Reviewer feedback
  // -----------------------------------------------------------------------

  private async getReviewerFeedback(
    ctx: WorkflowContext,
    draft: string,
    reviewer: ReviewerConfig,
    cycle: number,
  ): Promise<ReviewFeedback> {
    const llm = ctx.getLLM();

    const prompt = [
      {
        type: "system" as const,
        content:
          `You are a peer reviewer with persona "${reviewer.persona}" (ID: "${reviewer.id}"). ` +
          `Review the following draft thoroughly. Respond with JSON only:\n` +
          `{"assessment": "accept|minor_revision|major_revision|reject", "feedback": "detailed feedback", "issues": ["issue1", "issue2"], "strengths": ["strength1"]}`,
      },
      {
        type: "user" as const,
        content: `Review cycle: ${cycle}\n\nDraft to review:\n${draft.substring(0, 4000)}`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      const text = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

      return ReviewFeedbackSchema.parse({
        reviewerId: reviewer.id,
        assessment: (parsed.assessment as string) ?? "major_revision",
        feedback: (parsed.feedback as string) ?? "No feedback provided",
        issues: (parsed.issues as string[]) ?? [],
        strengths: (parsed.strengths as string[]) ?? [],
      });
    } catch (err) {
      ctx.logger.warn(`PeerReviewModule: Reviewer ${reviewer.id} failed: ${(err as Error).message}`);
      return {
        reviewerId: reviewer.id,
        assessment: "major_revision",
        feedback: "Review generation failed",
        issues: ["Unable to generate review"],
        strengths: [],
      };
    }
  }

  // -----------------------------------------------------------------------
  // Draft revision
  // -----------------------------------------------------------------------

  private async reviseDraft(
    ctx: WorkflowContext,
    draft: string,
    feedback: ReviewFeedback[],
    config: Config,
  ): Promise<string> {
    const llm = ctx.getLLM(config.revisionModel ? { llmModel: config.revisionModel } : undefined);

    const feedbackSummary = feedback
      .map((f) => `[${f.reviewerId}] ${f.assessment}: ${f.feedback}\nIssues: ${f.issues.join(", ")}`)
      .join("\n\n");

    const prompt = [
      {
        type: "system" as const,
        content:
          "You are an author revising a draft based on peer review feedback. " +
          "Incorporate the feedback to improve the draft while preserving its strengths. " +
          "Return only the revised draft text.",
      },
      {
        type: "user" as const,
        content: `Original draft:\n${draft.substring(0, 3000)}\n\nReviewer feedback:\n${feedbackSummary}\n\nPlease produce the revised draft.`,
      },
    ];

    try {
      const resp = await llm.invoke(prompt);
      return typeof resp.content === "string" ? resp.content : draft;
    } catch {
      return draft;
    }
  }

  // -----------------------------------------------------------------------
  // KG persistence
  // -----------------------------------------------------------------------

  private async persistReviewSession(ctx: WorkflowContext, state: PeerReviewState): Promise<void> {
    try {
      const sessionId = `review-${uuidv4()}`;
      await ctx.memgraph.query(
        `CREATE (r:ReviewSession {
           id: $id,
           cycles: $cycles,
           accepted: $accepted,
           timestamp: $timestamp
         })`,
        {
          id: sessionId,
          cycles: state.currentCycle,
          accepted: state.accepted,
          timestamp: new Date().toISOString(),
        },
      );
    } catch (err) {
      ctx.logger.warn(`PeerReviewModule: KG persistence failed: ${(err as Error).message}`);
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}
