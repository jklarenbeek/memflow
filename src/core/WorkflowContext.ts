/**
 * WorkflowContext — Dependency Injection Container
 *
 * The single most important architectural addition in the merge. This class
 * holds all shared runtime resources (logger, Memgraph, LLM, Embeddings)
 * and provides per-module provider overrides.
 *
 * Lifecycle:
 *  1. `WorkflowContext.create(globalConfig)` — creates all providers
 *  2. Passed to every `module.init(context)` and `module.process(input, context)`
 *  3. `context.shutdown()` — tears down all connections
 *
 * Design decisions:
 *  - LLM/Embedding instances are cached by config key (no re-creation)
 *  - MemgraphClient is a true singleton per context
 *  - Logger is Winston-based but behind an interface (testable)
 *  - Trace entries are accumulated for observability
 */

import winston from "winston";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { v4 as uuidv4 } from "uuid";

import type { GlobalConfig, WorkflowConfig, WorkflowState, WorkflowData } from "./types.js";
import { MemgraphClient, type Logger } from "../providers/MemgraphClient.js";
import { createLLM } from "../providers/LLMProvider.js";
import { createEmbeddings } from "../providers/EmbeddingProvider.js";
import { getDimensions } from "../providers/EmbeddingModelRegistry.js";
import { validateAllPrompts, startPromptWatcher } from "../utils/promptLoader.js";
import type { WorkflowEventEmitter } from "./WorkflowEventEmitter.js";

// ---------------------------------------------------------------------------
// Trace entry for observability
// ---------------------------------------------------------------------------

export interface TraceEntry {
  stage: string;
  timestamp: string;
  durationMs: number;
  inputSummary: string;
  outputSummary: string;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export class WorkflowContext {
  readonly workflowId: string;
  readonly logger: Logger;
  readonly memgraph: MemgraphClient;
  readonly trace: TraceEntry[] = [];

  /**
   * The embedding model name — locked at initialization.
   * Vectors from different models are incompatible in the same index.
   */
  readonly embeddingModel: string;

  /**
   * The embedding vector dimensions — derived from the model registry.
   */
  readonly embeddingDimensions: number;
  readonly globalConfig: GlobalConfig;

  /**
   * Event emitter for streaming pattern events.
   *
   * Injected by WorkflowEngine during initialize() / initializeWithContext().
   * Pattern modules use this (via `emitPatternEvent()` utility) instead of
   * duck-typed access. `undefined` in non-streaming or test contexts.
   */
  eventEmitter?: WorkflowEventEmitter;

  /** Sub-workflow recursion depth tracker (per workflow tree) */
  depth = 0;

  private readonly llmCache = new Map<string, BaseChatModel>();
  private readonly embCache = new Map<string, Embeddings>();

  private constructor(
    workflowId: string,
    logger: Logger,
    memgraph: MemgraphClient,
    globalConfig: GlobalConfig,
  ) {
    this.workflowId = workflowId;
    this.logger = logger;
    this.memgraph = memgraph;
    this.globalConfig = globalConfig;

    // Lock embedding model at construction time
    this.embeddingModel = globalConfig.embeddingModel ?? "nomic-embed-text";
    this.embeddingDimensions = getDimensions(this.embeddingModel);
  }

  /**
   * Factory: create a fully-initialised context from global config.
   */
  static async create(config: GlobalConfig = {}): Promise<WorkflowContext> {
    const logger = WorkflowContext.createLogger(config.logLevel ?? "info");

    const memgraph = new MemgraphClient(
      {
        uri: config.memgraphUri ?? process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
        user: config.memgraphUser ?? process.env.MEMGRAPH_USER ?? "memgraph",
        password: config.memgraphPassword ?? process.env.MEMGRAPH_PASSWORD ?? "memgraph",
      },
      logger,
    );

    // Ensure core vector indexes exist — dimensions from model registry
    const embModel = config.embeddingModel ?? "nomic-embed-text";
    const embDim = getDimensions(embModel);
    logger.info(`Embedding model: ${embModel} (${embDim}D)`);
    try {
      await memgraph.ensureVectorIndex("Chunk", "embedding", embDim, "chunk_emb_idx");
      await memgraph.ensureVectorIndex("MemoryUnit", "embedding", embDim, "mem_emb_idx");
    } catch {
      logger.warn("Could not ensure vector indexes — Memgraph may not be available");
    }

    const ctx = new WorkflowContext(uuidv4(), logger, memgraph, config);

    // Eagerly instantiate the default LLM and embeddings clients
    // so that config errors surface at startup, not mid-pipeline.
    // Note: no network calls are made here — actual model loading
    // happens on the first invoke/embed call.
    ctx.getLLM();
    ctx.getEmbeddings();

    // Improvement #8: Validate all TOML prompt references at startup
    try {
      const promptValidation = validateAllPrompts();
      if (promptValidation.missing.length > 0) {
        logger.warn(
          `Missing TOML prompt templates: ${promptValidation.missing.join(", ")}`,
          { missing: promptValidation.missing },
        );
      }
      if (promptValidation.parseErrors.length > 0) {
        logger.warn(
          `TOML prompt parse errors: ${promptValidation.parseErrors.map((e) => `${e.path}: ${e.error}`).join("; ")}`,
          { parseErrors: promptValidation.parseErrors },
        );
      }
      if (promptValidation.valid.length > 0) {
        logger.info(
          `TOML prompt validation: ${promptValidation.valid.length} valid, ${promptValidation.missing.length} missing, ${promptValidation.parseErrors.length} errors`,
        );
      }
    } catch {
      logger.debug("Prompt validation skipped (prompts directory not found)");
    }

    // Improvement #15: Start hot-reload file watcher for TOML prompts
    startPromptWatcher((changedPath) => {
      logger.info(`TOML prompt reloaded: ${changedPath}`);
    });

    logger.info("WorkflowContext created", { workflowId: ctx.workflowId });
    return ctx;
  }

  // -----------------------------------------------------------------------
  // Provider access with per-module override
  // -----------------------------------------------------------------------

  /**
   * Get an LLM instance. If `moduleConfig` specifies a different provider
   * or model, a separate cached instance is returned.
   */
  getLLM(moduleConfig?: {
    llmProvider?: string;
    llmModel?: string;
  }): BaseChatModel {
    const provider =
      (moduleConfig?.llmProvider as GlobalConfig["llmProvider"]) ??
      this.globalConfig.llmProvider ??
      "ollama";
    const model =
      moduleConfig?.llmModel ??
      this.globalConfig.llmModel ??
      (provider === "ollama" ? "qwen3.5:9b" : "anthropic/claude-3.5-sonnet");

    const cacheKey = `${provider}:${model}`;
    if (!this.llmCache.has(cacheKey)) {
      this.llmCache.set(cacheKey, createLLM({ provider, model }));
    }
    return this.llmCache.get(cacheKey)!;
  }

  /**
   * Get the SINGLETON Embeddings instance.
   *
   * IMPORTANT: The embedding model is locked at initialization.
   * Vectors from different models are incompatible in the same vector index.
   * Per-module overrides are IGNORED — all modules share the same embeddings.
   *
   * @param _moduleConfig Deprecated — ignored. Kept for backward compat.
   */
  getEmbeddings(_moduleConfig?: {
    embedderProvider?: string;
    embedderModel?: string;
  }): Embeddings {
    if (
      _moduleConfig?.embedderProvider ||
      _moduleConfig?.embedderModel
    ) {
      this.logger.warn(
        "getEmbeddings: Per-module embedding overrides are ignored. " +
          `System embedding model is locked to ${this.embeddingModel} (${this.embeddingDimensions}D). ` +
          "Vectors from different models are incompatible.",
      );
    }

    const provider = this.globalConfig.embeddingProvider ?? "ollama";
    const model = this.embeddingModel;

    const cacheKey = `emb:${provider}:${model}`;
    if (!this.embCache.has(cacheKey)) {
      this.embCache.set(cacheKey, createEmbeddings({ provider, model }));
    }
    return this.embCache.get(cacheKey)!;
  }

  // -----------------------------------------------------------------------
  // Tracing
  // -----------------------------------------------------------------------

  addTrace(
    stage: string,
    input: unknown,
    output: unknown,
    durationMs: number,
  ): void {
    this.trace.push({
      stage,
      timestamp: new Date().toISOString(),
      durationMs,
      inputSummary: summarize(input),
      outputSummary: summarize(output),
    });
  }

  // -----------------------------------------------------------------------
  // Sub-workflow execution
  // -----------------------------------------------------------------------

  /**
   * Execute a child workflow within this context.
   *
   * Shares all parent resources (LLM, Memgraph, Logger, tracing, events)
   * with the child engine. Manages recursion depth automatically.
   *
   * @param workflowConfig  The child workflow definition (inline or loaded from JSON)
   * @param inputData       Initial data to seed the child workflow
   * @param stageOverrides  Optional per-stage config overrides (keyed by stage ID)
   * @param maxDepth        Maximum recursion depth (default 5)
   * @returns               The completed child WorkflowState
   *
   * @example
   *   const childState = await ctx.runSubWorkflow(
   *     traceToSkillPipeline,
   *     { experienceLibrary },
   *     { cluster: { k: 10 }, merge: { persistToGraph: true } },
   *   );
   */
  async runSubWorkflow(
    workflowConfig: WorkflowConfig,
    inputData: Partial<WorkflowData> = {},
    stageOverrides?: Record<string, Record<string, unknown>>,
    maxDepth = 5,
  ): Promise<WorkflowState> {
    if (this.depth >= maxDepth) {
      throw new Error(
        `Sub-workflow recursion depth exceeded (max ${maxDepth}). ` +
          `Check for circular workflow references.`,
      );
    }

    // Lazy import to avoid circular dependency:
    // WorkflowContext ←→ WorkflowEngine both reference each other.
    const { WorkflowEngine } = await import("./WorkflowEngine.js");

    this.depth++;
    try {
      const childEngine = new WorkflowEngine(workflowConfig);

      if (stageOverrides) {
        childEngine.setStageConfigOverrides(stageOverrides);
      }

      await childEngine.initializeWithContext(this);
      return await childEngine.run(inputData);
    } finally {
      this.depth--;
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    await this.memgraph.close();
    this.logger.info("WorkflowContext shutdown complete", {
      workflowId: this.workflowId,
    });
  }

  // -----------------------------------------------------------------------
  // Logger factory
  // -----------------------------------------------------------------------

  private static createLogger(level: string): Logger {
    return winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
      defaultMeta: { service: "memflow" },
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({
          filename: process.env.LOG_FILE_PATH || "logs/memflow.log",
        }),
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarize(value: unknown, maxLen = 200): string {
  try {
    const str = JSON.stringify(value);
    return str.length > maxLen ? str.substring(0, maxLen) + "…" : str;
  } catch {
    return String(value).substring(0, maxLen);
  }
}
