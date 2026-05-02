/**
 * MemFlow Core Type System
 *
 * Replaces the `Record<string, any>` soup from both projects with a typed
 * shared state model. Key design decisions:
 *
 *  - `WorkflowData` provides typed fields for all known inter-module data
 *    (chunks, embeddings, memory units, etc.) with an index signature escape
 *    hatch for custom extensions.
 *
 *  - `BaseModule<TConfig>` uses a generic for config so each module's Zod
 *    schema is enforced at the type level. Adds optional `init()` /
 *    `shutdown()` lifecycle hooks for resource management.
 *
 *  - Domain types (`MemoryUnit`, `RetrievalResult`, `AgentTrajectory`, etc.)
 *    are defined here as the canonical shared vocabulary between modules.
 */

import { Document } from "@langchain/core/documents";
import { BaseMessage } from "@langchain/core/messages";
import type { ZodSchema } from "zod";

// ---------------------------------------------------------------------------
// Workflow Configuration (JSON-defined)
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  name: string;
  version: string;
  description?: string;
  entry: string;
  stages: WorkflowStage[];
  globalConfig?: GlobalConfig;
  meta?: WorkflowMeta;
}

export interface WorkflowStage {
  id: string;
  module: string;
  config: Record<string, unknown>;
  dependsOn?: string[];
  next?: string | string[] | { [condition: string]: string } | null;
  parallel?: boolean;
  retry?: number;
  retryDelayMs?: number;
  /** Inline sub-workflow definition (for SubWorkflow module) */
  workflow?: WorkflowConfig;
  /** File path to external sub-workflow JSON (for SubWorkflow module) */
  workflowRef?: string;
  /** Map parent data keys → child input keys */
  inputMap?: Record<string, string>;
  /** Map child output keys → parent data keys */
  outputMap?: Record<string, string>;
}

export interface GlobalConfig {
  llmProvider?: "ollama" | "openrouter" | "openai";
  llmModel?: string;
  embeddingProvider?: "ollama" | "openrouter" | "openai";
  embeddingModel?: string;
  memgraphUri?: string;
  memgraphUser?: string;
  memgraphPassword?: string;
  maxConcurrency?: number;
  tokenBudget?: number;
  logLevel?: "debug" | "info" | "warn" | "error";
  enableMetrics?: boolean;
  tenantId?: string;
}

export interface WorkflowMeta {
  learning?: boolean;
  maxIterations?: number;
  metrics?: string[];
  autoResearch?: boolean;
}

// ---------------------------------------------------------------------------
// Workflow Runtime State
// ---------------------------------------------------------------------------

export interface WorkflowState {
  id: string;
  currentStage: string;
  data: WorkflowData;
  history: HistoryEntry[];
  iteration: number;
  errors: StageError[];
  metadata: WorkflowMetadata;
}

export interface HistoryEntry {
  stage: string;
  output: unknown;
  timestamp: string;
  durationMs: number;
}

export interface StageError {
  stage: string;
  error: string;
  attempt: number;
  timestamp: string;
}

export interface WorkflowMetadata {
  startTime: string;
  endTime?: string;
  providers: { llm: string; embeddings: string };
  workflowName: string;
  totalDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Shared Data Bus — typed fields for inter-module communication
// ---------------------------------------------------------------------------

export interface WorkflowData {
  // Query stage
  query?: string;
  expandedQueries?: string[];

  // Document / chunking stage
  documents?: Document[];
  chunks?: Document[];
  markdown?: string;

  // Embedding stage
  embeddings?: number[][];

  // Memory stage
  memoryUnits?: MemoryUnit[];
  retrievalScope?: string;

  // Atomic memory pipeline stages
  windowedChunks?: Document[][];
  filteredChunks?: Document[];
  topicSegments?: MemoryUnit[][];

  // Graph stage
  graphContext?: string;
  entities?: Array<{ name: string; type: string; description: string }>;
  relationships?: Array<{ source: string; target: string; type: string; description: string; keywords: string[] }>;

  // Retrieval stage
  retrievalResult?: RetrievalResult;
  candidates?: Array<{ id: string; text: string; embedding: number[]; score: number; source: string; metadata: Record<string, unknown> }>;
  searchScope?: string;

  // Agent / orchestration stage
  agentResult?: AgentResult;
  agentPlan?: AgentPlan;
  trajectory?: AgentTrajectory;
  insights?: string[];

  // Generation stage
  finalAnswer?: string;
  sources?: string[];
  confidence?: number;
  clarifications?: string[];

  // Metrics (accumulated across stages)
  metrics?: ModuleMetrics;

  // LightMem tier state (Phase 1)
  existingMemories?: MemoryUnit[];

  // SimpleMem multi-view retrieval (Phase 2)
  semanticQuery?: string;
  lexicalQuery?: string;
  symbolicFilter?: string;
  retrievalDepth?: number;

  // HERA learning state (Phase 3)
  previousTrajectories?: AgentTrajectory[];
  consecutiveFailures?: number;
  evolvedRolePrompts?: Record<string, string>;
  mutatedTopology?: { addAgents: string[]; removeAgents: string[] };
  experienceLibrary?: ExperienceEntry[];

  // Agent abstraction (Phase 4)
  agentIdentity?: AgentIdentity;
  outcomeReport?: OutcomeReport;

  // Escape hatch for custom data
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Module Interface
// ---------------------------------------------------------------------------

export interface ModuleInput<TConfig = Record<string, unknown>> {
  /** Shared workflow data bus */
  data: WorkflowData;
  /** Zod-parsed module-specific config */
  config: TConfig;
}

export interface ModuleOutput {
  /** Partial updates to the shared data bus (merged into state.data) */
  data: Partial<WorkflowData>;
  /** Module-level metrics (merged into state.data.metrics) */
  metrics?: ModuleMetrics;
}

export interface ModuleMetrics {
  /**
   * Standard telemetry counters (Improvement #10).
   * Modules should populate these when relevant for cost estimation
   * and resource tracking.
   */
  tokenUsage?: number;
  memgraphQueries?: number;
  embeddingCalls?: number;

  /** Allow module-specific metrics */
  [key: string]: number | string | boolean | undefined;
}

/**
 * Base module contract. Every MemFlow module implements this interface.
 *
 * The generic TConfig parameter allows each module to declare its own
 * Zod-validated configuration shape, replacing `Record<string, any>`.
 *
 * Lifecycle:
 *  - `init()` — called once after WorkflowContext is ready (optional)
 *  - `process()` — called per-stage during workflow execution
 *  - `shutdown()` — called when the workflow engine is torn down (optional)
 */
export interface BaseModule<TConfig = Record<string, unknown>> {
  readonly name: string;
  readonly version: string;

  /** Optional one-time initialization (DB connections, warm-up, etc.) */
  init?(context: unknown): Promise<void>;

  /** Core processing — receives typed input, returns typed output */
  process(input: ModuleInput<TConfig>, context: unknown): Promise<ModuleOutput>;

  /** Optional cleanup (close connections, flush buffers, etc.) */
  shutdown?(): Promise<void>;

  /** Returns the Zod schema for this module's config */
  getConfigSchema(): ZodSchema;

  /** Whether this module's config can be evolved by the learning loop */
  supportsLearning(): boolean;
}

// ---------------------------------------------------------------------------
// Domain Types — shared vocabulary between modules
// ---------------------------------------------------------------------------

export interface MemoryUnit {
  id: string;
  content: string;
  embedding: number[];
  timestamp: Date;
  type: "fact" | "event" | "summary" | "relation";
  /** LightMem §3.2: Original user utterance that triggered this memory unit */
  userContent?: string;
  /** LightMem §3.2: Model response that generated/contributed to this unit */
  modelContent?: string;
  /** Model identifier (e.g. "llama3.2", "gpt-4o-mini") for provenance tracking */
  modelId?: string;
  /** Provider identifier (e.g. "ollama", "openrouter", "openai") for provenance tracking */
  providerId?: string;
  /** User identifier — relates questions to answers for attribution */
  userId?: string;
  /** First-class topic label (LightMem §3.2: topic field in LTM entry structure) */
  topicLabel?: string;
  metadata: {
    source?: string;
    confidence?: number;
    entities?: string[];
    temporal?: string;
    originalIds?: string[];
    [key: string]: unknown;
  };
  relations?: MemoryRelation[];
}

export interface MemoryRelation {
  targetId: string;
  type: string;
  weight: number;
}

export interface RetrievalResult {
  chunks: Document[];
  memories: MemoryUnit[];
  graphPaths: unknown[];
  score: number;
  sources: string[];
}

export interface AgentResult {
  answer: string;
  trajectory: AgentTrajectory;
  insights: string[];
}

export interface AgentTrajectory {
  query: string;
  plan: AgentPlan;
  steps: AgentStep[];
  finalAnswer: string;
  reward: number;
  insights: string[];
}

export interface AgentPlan {
  agents: string[];
  order: "sequential" | "parallel";
  dependencies?: Record<string, string[]>;
  tokenBudget?: number;
}

export interface AgentStep {
  agent: string;
  action: string;
  result: string;
  durationMs?: number;
}

/** Experience library entry (HERA paper: Profile-Insight-Utility) */
export interface ExperienceEntry {
  /** Context profile — abbreviated query that generated this insight */
  context: string;
  /** Insight — natural language strategy learned */
  insight: string;
  /** Utility score — reinforced or decayed over time */
  utility: number;
}

// ---------------------------------------------------------------------------
// Agent Abstraction Types (Phase 4)
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  id: string;
  name: string;
  fleetId?: string;
  tenantId: string;
  trustLevel: 0 | 1 | 2 | 3;
  retrievalProfile?: RetrievalProfile;
  createdAt: string;
}

export interface RetrievalProfile {
  topK: number;
  minSimilarity: number;
  graphMaxHops: number;
  semanticWeight: number;
  keywordWeight: number;
  freshnessDecay: number;
}

export interface OutcomeReport {
  agentId: string;
  memoryIds: string[];
  outcome: "success" | "failure" | "partial";
  context: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Streaming Types (Improvement #9: SSE support)
// ---------------------------------------------------------------------------

/**
 * Progress information included in stage events, letting clients
 * render progress bars / stage indicators.
 */
export interface StageProgress {
  /** Number of completed stages so far */
  completed: number;
  /** Total number of stages in the workflow */
  total: number;
}

/**
 * SSE event types emitted during streaming workflow execution.
 *
 * Design principle: discriminated union on `type` field so clients
 * can switch/case on the event type and get full type narrowing.
 *
 * The `type` field maps directly to the SSE `event:` line, e.g.:
 *   event: stage:progress
 *   data: {"stageId":"generate","token":"The",...}
 */
export type StreamEvent =
  | StreamEventWorkflowStart
  | StreamEventStageStart
  | StreamEventStageProgress
  | StreamEventStageComplete
  | StreamEventStageError
  | StreamEventWorkflowComplete
  | StreamEventWorkflowError;

export interface StreamEventWorkflowStart {
  type: "workflow:start";
  workflowId: string;
  name: string;
  stages: string[];
  timestamp: string;
}

export interface StreamEventStageStart {
  type: "stage:start";
  stageId: string;
  module: string;
  attempt: number;
  progress: StageProgress;
  timestamp: string;
}

export interface StreamEventStageProgress {
  type: "stage:progress";
  stageId: string;
  module: string;
  /** Streamed token from LLM output */
  token: string;
  /** Token index within the current stage's output */
  tokenIndex: number;
  timestamp: string;
}

export interface StreamEventStageComplete {
  type: "stage:complete";
  stageId: string;
  module: string;
  durationMs: number;
  metrics?: ModuleMetrics;
  /** Short preview of the output for UI display */
  preview?: string;
  progress: StageProgress;
  timestamp: string;
}

export interface StreamEventStageError {
  type: "stage:error";
  stageId: string;
  module: string;
  error: string;
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
  timestamp: string;
}

export interface StreamEventWorkflowComplete {
  type: "workflow:complete";
  workflowId: string;
  totalDurationMs: number;
  finalAnswer?: string;
  confidence?: number;
  sources?: string[];
  timestamp: string;
}

export interface StreamEventWorkflowError {
  type: "workflow:error";
  workflowId: string;
  error: string;
  stage?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Streamable Module Interface (Improvement #9)
// ---------------------------------------------------------------------------

/**
 * Extended module interface that supports token-level streaming.
 *
 * Modules implement this interface INSTEAD OF (or IN ADDITION TO) BaseModule
 * when they can produce incremental output — typically LLM-backed generation
 * modules like AnswerGenerator and FinalSynthesizer.
 *
 * The engine detects `processStream` at runtime and falls back to `process()`
 * for modules that don't implement it. This means:
 *  - Existing modules need ZERO changes
 *  - Streaming is opt-in per module
 *  - The non-streaming `run()` path is completely unaffected
 */
export interface StreamableModule<TConfig = Record<string, unknown>>
  extends BaseModule<TConfig> {
  /**
   * Streaming variant of `process()`.
   *
   * Yields `StreamEvent` objects (typically `stage:progress` with tokens)
   * during execution. The LAST yielded event MUST be a `stage:complete`
   * containing the final `ModuleOutput` data in its metrics/preview.
   *
   * The engine collects all yielded events and also extracts the final
   * ModuleOutput from the return value for state merging.
   *
   * @returns An AsyncGenerator that yields StreamEvents, and returns
   *          the final ModuleOutput when done.
   */
  processStream(
    input: ModuleInput<TConfig>,
    context: unknown,
  ): AsyncGenerator<StreamEvent, ModuleOutput, undefined>;
}