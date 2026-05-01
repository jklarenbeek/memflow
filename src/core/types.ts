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

  // Graph stage
  graphContext?: string;

  // Retrieval stage
  retrievalResult?: RetrievalResult;

  // Agent / orchestration stage
  agentResult?: AgentResult;

  // Generation stage
  finalAnswer?: string;
  sources?: string[];
  confidence?: number;

  // Metrics (accumulated across stages)
  metrics?: ModuleMetrics;

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
  [key: string]: number | string;
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