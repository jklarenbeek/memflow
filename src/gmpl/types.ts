/**
 * GMPL Type System — Generic Multi-Agent Pattern Library
 *
 * Zod schemas and TypeScript interfaces for the GMPL extension layer.
 * All inter-module data for GMPL patterns is defined here as the canonical
 * shared vocabulary between GMPL modules.
 *
 * Design: mirrors the core `types.ts` pattern — Zod schemas for runtime
 * validation, TypeScript interfaces for compile-time checks.
 */

import { z, type ZodSchema } from "zod";

// ---------------------------------------------------------------------------
// Pattern Registry Types
// ---------------------------------------------------------------------------

/**
 * A reusable workflow pattern definition.
 *
 * Patterns are self-contained sub-workflow templates with typed contracts.
 * They can be composed, nested, and selected by HERA.
 */
export interface WorkflowPattern {
  /** Unique pattern identifier (e.g. 'structured_debate') */
  id: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** Path to the sub-workflow JSON (relative to project root) */
  workflowRef: string;
  /** Zod schema for pattern-specific config validation */
  configSchema: ZodSchema;
  /** Role IDs this pattern needs (from RoleRegistry) */
  requiredRoles: string[];
  /** What data this pattern expects on the WorkflowData bus */
  inputContract: ZodSchema;
  /** What data this pattern produces on the WorkflowData bus */
  outputContract: ZodSchema;
  /** Pattern-specific SSE event types */
  observabilityEvents: string[];
}

// ---------------------------------------------------------------------------
// Role Registry Types
// ---------------------------------------------------------------------------

/**
 * A reusable, domain-agnostic agent role definition.
 *
 * Roles define the persona, capabilities, and contracts for agents
 * within patterns. They can be extended with domain-specific overrides.
 */
export interface AgentRole {
  /** Unique role identifier (e.g. 'domain_analyst') */
  id: string;
  /** Base role to extend from (for specialization) */
  base?: string;
  /** Human-readable description */
  description: string;
  /** Default persona name */
  persona: string;
  /** Path to TOML prompt pack (relative to src/prompts/) */
  promptPack?: string;
  /** Zod schema for role input data */
  inputSchema: ZodSchema;
  /** Zod schema for role output data */
  outputSchema: ZodSchema;
  /** MemFlow modules this role requires */
  requiredModules: string[];
  /** Optional tool overrides */
  toolOverrides?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Domain Adapter Types
// ---------------------------------------------------------------------------

/** Function signature for domain data providers */
export type DataProviderFn = (...args: unknown[]) => Promise<unknown>;

/** Prompt pack reference — maps to a TOML file */
export interface PromptPack {
  /** Path to TOML file (relative to src/prompts/) */
  path: string;
  /** Version identifier */
  version: string;
}

/** KG seed data for domain initialization */
export interface KGSeed {
  entities: Array<{ name: string; type: string; description: string }>;
  relations: Array<{ source: string; target: string; type: string }>;
}

/**
 * Domain adapter plugin contract.
 *
 * Bundles data providers, evaluators, prompts, and schemas into a
 * single registration unit for a specific domain.
 */
export interface DomainAdapter {
  /** Unique domain identifier (e.g. 'trading', 'healthcare') */
  id: string;
  /** Semantic version */
  version: string;

  // Data & Tools
  dataProviders: Record<string, DataProviderFn>;
  entitySchemas: ZodSchema[];

  // Evaluation & Metrics
  outcomeEvaluator: (
    pending: PendingDecision,
    context: Record<string, unknown>,
  ) => Promise<OutcomeResult>;
  metricsCalculator: (
    decisions: Decision[],
  ) => Record<string, number | string>;

  // Prompts & Knowledge
  promptPacks: Record<string, PromptPack>;
  seedKnowledge?: () => Promise<KGSeed>;

  // Observability
  customMetrics?: Record<string, string>;

  /**
   * Authority safelist — URL patterns that receive an authority boost
   * during dual-source fusion. When set, only URLs matching these patterns
   * will receive elevated trust scoring.
   *
   * Examples: [".gov", ".edu", ".reuters.", ".nih.", ".who."]
   */
  authoritySafelist?: string[];
}

// ---------------------------------------------------------------------------
// Debate Pattern Schemas (Pattern A)
// ---------------------------------------------------------------------------

export const DebatePositionSchema = z.object({
  /** Which role produced this position */
  roleId: z.string(),
  /** The stance taken */
  stance: z.string(),
  /** Supporting evidence */
  evidence: z.array(z.string()),
  /** Confidence in this position (0–1) */
  confidence: z.number().min(0).max(1),
  /** Rebuttal to opposing position(s) from previous round */
  rebuttal: z.string().optional(),
  /** Round number */
  round: z.number(),
});

export type DebatePosition = z.infer<typeof DebatePositionSchema>;

export const ConsensusReportSchema = z.object({
  /** Final verdict from the judge */
  verdict: z.string(),
  /** Convergence score (0–1): how close the debaters are */
  convergenceScore: z.number().min(0).max(1),
  /** Key findings agreed upon */
  keyFindings: z.array(z.string()),
  /** Remaining disagreements */
  dissent: z.array(z.string()),
  /** Recommended action */
  action: z.enum(["accept", "reject", "continue", "escalate"]),
  /** Total rounds completed */
  roundsCompleted: z.number(),
});

export type ConsensusReport = z.infer<typeof ConsensusReportSchema>;

export const DebateStateSchema = z.object({
  /** All positions across all rounds */
  positions: z.array(DebatePositionSchema),
  /** Current round number */
  currentRound: z.number(),
  /** Whether the debate has concluded */
  concluded: z.boolean(),
  /** Consensus report (if concluded) */
  consensusReport: ConsensusReportSchema.optional(),
});

export type DebateState = z.infer<typeof DebateStateSchema>;

// ---------------------------------------------------------------------------
// Clarification Pipeline Schemas (Pattern B)
// ---------------------------------------------------------------------------

export const UserClarificationTurnSchema = z.object({
  /** Turn number */
  turn: z.number(),
  /** Questions posed to the user */
  questions: z.array(z.string()),
  /** User's response */
  response: z.string().optional(),
  /** Timestamp */
  timestamp: z.string(),
});

export type UserClarificationTurn = z.infer<typeof UserClarificationTurnSchema>;

export const ClarificationStateSchema = z.object({
  /** Original query */
  originalQuery: z.string(),
  /** Conversation history */
  turns: z.array(UserClarificationTurnSchema),
  /** Current turn number */
  currentTurn: z.number(),
  /** Whether intent has been resolved */
  intentResolved: z.boolean(),
  /** Refined query (after clarification) */
  refinedQuery: z.string().optional(),
  /** Detected intent */
  detectedIntent: z.string().optional(),
  /** Expanded sub-queries */
  expandedQueries: z.array(z.string()).optional(),
});

export type ClarificationState = z.infer<typeof ClarificationStateSchema>;

// ---------------------------------------------------------------------------
// Parallel Analysis Schemas (Pattern C)
// ---------------------------------------------------------------------------

export const AnalystReportSchema = z.object({
  /** Analyst identifier */
  analystId: z.string(),
  /** The analysis content */
  analysis: z.string(),
  /** Confidence in the analysis (0–1) */
  confidence: z.number().min(0).max(1),
  /** Sources used */
  sources: z.array(z.string()),
  /** Key recommendations */
  recommendations: z.array(z.string()),
});

export type AnalystReport = z.infer<typeof AnalystReportSchema>;

export const MergedAnalysisSchema = z.object({
  /** Synthesized analysis from all reports */
  synthesis: z.string(),
  /** Number of reports merged */
  reportCount: z.number(),
  /** Merge strategy used */
  mergeStrategy: z.string(),
  /** Average confidence across reports */
  averageConfidence: z.number(),
  /** Aggregated recommendations (deduplicated) */
  recommendations: z.array(z.string()),
});

export type MergedAnalysis = z.infer<typeof MergedAnalysisSchema>;

// ---------------------------------------------------------------------------
// Peer Review Schemas (Pattern D — Phase 2, types defined now)
// ---------------------------------------------------------------------------

export const ReviewFeedbackSchema = z.object({
  /** Reviewer role ID */
  reviewerId: z.string(),
  /** Overall assessment */
  assessment: z.enum(["accept", "minor_revision", "major_revision", "reject"]),
  /** Detailed feedback */
  feedback: z.string(),
  /** Specific issues found */
  issues: z.array(z.string()),
  /** Strengths identified */
  strengths: z.array(z.string()),
});

export type ReviewFeedback = z.infer<typeof ReviewFeedbackSchema>;

export const ReviewCycleSchema = z.object({
  /** Cycle number */
  cycle: z.number(),
  /** The draft being reviewed */
  draft: z.string(),
  /** Feedback from reviewers */
  feedback: z.array(ReviewFeedbackSchema),
  /** Whether the draft was accepted */
  accepted: z.boolean(),
});

export type ReviewCycle = z.infer<typeof ReviewCycleSchema>;

export const PeerReviewStateSchema = z.object({
  /** The current draft being reviewed */
  draft: z.string(),
  /** All review cycles */
  cycles: z.array(ReviewCycleSchema),
  /** Current cycle number */
  currentCycle: z.number(),
  /** Whether the draft has been accepted */
  accepted: z.boolean(),
});

export type PeerReviewState = z.infer<typeof PeerReviewStateSchema>;

// ---------------------------------------------------------------------------
// Red Team Schemas (Pattern E — Phase 2)
// ---------------------------------------------------------------------------

export const AttackSchema = z.object({
  /** Attacker role ID */
  attackerId: z.string(),
  /** Strategy seed used to generate this attack */
  strategy: z.string(),
  /** The attack content (freeform LLM-generated, seeded by strategy) */
  attack: z.string(),
  /** Identified weakness targeted */
  targetWeakness: z.string(),
  /** Round number */
  round: z.number(),
});

export type Attack = z.infer<typeof AttackSchema>;

export const DefenseSchema = z.object({
  /** Defender role ID */
  defenderId: z.string(),
  /** The defense content */
  defense: z.string(),
  /** Specific mitigations proposed */
  mitigations: z.array(z.string()),
  /** Confidence in the defense (0–1) */
  confidence: z.number().min(0).max(1),
  /** Round number */
  round: z.number(),
});

export type Defense = z.infer<typeof DefenseSchema>;

export const ResilienceReportSchema = z.object({
  /** Final resilience verdict */
  verdict: z.string(),
  /** Overall resilience score (0–1) */
  resilienceScore: z.number().min(0).max(1),
  /** Vulnerabilities identified */
  vulnerabilities: z.array(z.string()),
  /** Strengths confirmed */
  strengths: z.array(z.string()),
  /** Recommended action */
  action: z.enum(["accept", "reject", "strengthen", "escalate"]),
  /** Total rounds completed */
  roundsCompleted: z.number(),
});

export type ResilienceReport = z.infer<typeof ResilienceReportSchema>;

export const RedTeamStateSchema = z.object({
  /** The proposal being stress-tested */
  proposal: z.string(),
  /** All attacks across all rounds */
  attacks: z.array(AttackSchema),
  /** All defenses across all rounds */
  defenses: z.array(DefenseSchema),
  /** Current round number */
  currentRound: z.number(),
  /** Whether the red team exercise has concluded */
  concluded: z.boolean(),
  /** Resilience report (if concluded) */
  resilienceReport: ResilienceReportSchema.optional(),
});

export type RedTeamState = z.infer<typeof RedTeamStateSchema>;

// ---------------------------------------------------------------------------
// Delphi Expert Panel Schemas (Pattern F — Phase 2)
// ---------------------------------------------------------------------------

export const PanelResponseSchema = z.object({
  /** Panelist identifier (anonymized if configured) */
  panelistId: z.string(),
  /** The response content */
  response: z.string(),
  /** Confidence in the response (0–1) */
  confidence: z.number().min(0).max(1),
  /** Reasoning behind the response */
  reasoning: z.string(),
  /** Round number */
  round: z.number(),
});

export type PanelResponse = z.infer<typeof PanelResponseSchema>;

export const AggregatedResultSchema = z.object({
  /** Round number */
  round: z.number(),
  /** All responses for this round */
  responses: z.array(PanelResponseSchema),
  /** Mean confidence */
  mean: z.number(),
  /** Standard deviation of confidence */
  stdDev: z.number(),
  /** Median confidence */
  median: z.number(),
  /** Convergence score (lower = more converged) */
  convergenceScore: z.number(),
});

export type AggregatedResult = z.infer<typeof AggregatedResultSchema>;

export const DelphiPanelStateSchema = z.object({
  /** The question being polled */
  question: z.string(),
  /** All aggregated round results */
  rounds: z.array(AggregatedResultSchema),
  /** Current round number */
  currentRound: z.number(),
  /** Whether the panel has converged */
  converged: z.boolean(),
  /** Final aggregation (if converged) */
  finalAggregation: AggregatedResultSchema.optional(),
});

export type DelphiPanelState = z.infer<typeof DelphiPanelStateSchema>;

// ---------------------------------------------------------------------------
// Outcome Memory Schemas
// ---------------------------------------------------------------------------

export const PendingDecisionSchema = z.object({
  /** Unique decision ID */
  id: z.string(),
  /** Which pattern produced this decision */
  patternId: z.string(),
  /** Domain adapter ID */
  domainId: z.string().optional(),
  /** The decision/recommendation content */
  content: z.string(),
  /** Entities mentioned in the decision */
  entityIds: z.array(z.string()),
  /** When the decision was made */
  timestamp: z.string(),
  /** When the decision should be resolved by */
  resolveBefore: z.string().optional(),
  /** Additional context */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type PendingDecision = z.infer<typeof PendingDecisionSchema>;

export const OutcomeResultSchema = z.object({
  /** Raw outcome data */
  raw: z.unknown(),
  /** Whether the decision was correct */
  outcome: z.enum(["success", "failure", "partial"]),
  /** Human-readable summary of the outcome */
  summary: z.string(),
  /** Additional domain-specific metrics */
  metrics: z.record(z.string(), z.unknown()).optional(),
});

export type OutcomeResult = z.infer<typeof OutcomeResultSchema>;

export const DecisionSchema = z.object({
  /** Original pending decision ID */
  pendingId: z.string(),
  /** The decision content */
  content: z.string(),
  /** Outcome result */
  outcome: OutcomeResultSchema,
  /** LLM-generated reflection */
  reflection: z.string(),
  /** Resolution timestamp */
  resolvedAt: z.string(),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const ReflectionSchema = z.object({
  /** Decision this reflection is about */
  decisionId: z.string(),
  /** The reflection content */
  content: z.string(),
  /** Lessons learned */
  lessons: z.array(z.string()),
  /** Confidence adjustment applied */
  confidenceAdjustment: z.number(),
  /** Timestamp */
  timestamp: z.string(),
});

export type Reflection = z.infer<typeof ReflectionSchema>;

// ---------------------------------------------------------------------------
// Pattern Composition Schema
// ---------------------------------------------------------------------------

export const PatternStageSchema = z.object({
  /** Stage identifier */
  id: z.string(),
  /** Pattern to execute (from PatternRegistry) */
  pattern: z.string().optional(),
  /** Module to execute directly (alternative to pattern) */
  module: z.string().optional(),
  /** Pattern/module config */
  config: z.record(z.string(), z.unknown()).prefault({}),
});

export const PatternCompositionSchema = z.object({
  /** Composition name */
  name: z.string(),
  /** Domain adapter ID */
  domain: z.string().optional(),
  /** HERA orchestration mode */
  orchestration: z.enum(["none", "hera"]).default("none"),
  /** Ordered stages */
  stages: z.array(PatternStageSchema),
  /** Outcome memory config */
  memory: z
    .object({
      twoPhaseEnabled: z.boolean().default(false),
      pendingTTL: z.string().default("30d"),
      reflectionModel: z.string().optional(),
      crossDomainLessons: z.boolean().default(false),
    })
    .optional(),
});

export type PatternComposition = z.infer<typeof PatternCompositionSchema>;
