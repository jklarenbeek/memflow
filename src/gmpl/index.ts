/**
 * GMPL — Generic Multi-Agent Pattern Library
 *
 * Public API barrel export for the GMPL extension layer.
 * Import from '@memflow/gmpl' or 'memflow/gmpl'.
 */

// Core registries
export { PatternRegistry } from "./PatternRegistry.js";
export { RoleRegistry } from "./RoleRegistry.js";
export { DomainRegistry } from "./DomainRegistry.js";

// Type system
export type {
  // Pattern types
  WorkflowPattern,
  AgentRole,
  DomainAdapter,
  DataProviderFn,
  PromptPack,
  KGSeed,

  // Debate schemas
  DebateState,
  DebatePosition,
  ConsensusReport,

  // Clarification schemas
  ClarificationState,
  UserClarificationTurn,

  // Analysis schemas
  AnalystReport,
  MergedAnalysis,

  // Review schemas (Phase 2)
  ReviewCycle,
  ReviewFeedback,

  // Outcome memory schemas
  PendingDecision,
  OutcomeResult,
  Decision,
  Reflection,

  // Composition
  PatternComposition,
} from "./types.js";

// Zod schemas (for runtime validation)
export {
  DebatePositionSchema,
  DebateStateSchema,
  ConsensusReportSchema,
  ClarificationStateSchema,
  UserClarificationTurnSchema,
  AnalystReportSchema,
  MergedAnalysisSchema,
  ReviewCycleSchema,
  ReviewFeedbackSchema,
  PendingDecisionSchema,
  OutcomeResultSchema,
  DecisionSchema,
  ReflectionSchema,
  PatternCompositionSchema,
  PatternStageSchema,
} from "./types.js";
