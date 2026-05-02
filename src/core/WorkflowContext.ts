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

import type { GlobalConfig } from "./types.js";
import { MemgraphClient, type Logger } from "../providers/MemgraphClient.js";
import { createLLM } from "../providers/LLMProvider.js";
import { createEmbeddings } from "../providers/EmbeddingProvider.js";
import { validateAllPrompts, startPromptWatcher } from "../utils/promptLoader.js";

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
  readonly globalConfig: GlobalConfig;

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

    // Ensure core vector indexes exist
    try {
      await memgraph.ensureVectorIndex("Chunk", "embedding", 768, "chunk_emb_idx");
      await memgraph.ensureVectorIndex("MemoryUnit", "embedding", 768, "mem_emb_idx");
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
   * Get an Embeddings instance. If `moduleConfig` specifies a different
   * provider or model, a separate cached instance is returned.
   */
  getEmbeddings(moduleConfig?: {
    embedderProvider?: string;
    embedderModel?: string;
  }): Embeddings {
    const provider =
      (moduleConfig?.embedderProvider as GlobalConfig["embeddingProvider"]) ??
      this.globalConfig.embeddingProvider ??
      "ollama";
    const model =
      moduleConfig?.embedderModel ??
      this.globalConfig.embeddingModel ??
      "nomic-embed-text";

    const cacheKey = `${provider}:${model}`;
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
      transports: [new winston.transports.Console()],
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
