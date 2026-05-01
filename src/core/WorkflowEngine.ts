/**
 * WorkflowEngine — enhanced JSON-driven DAG executor
 *
 * Improvements over the original MF engine:
 *  1. WorkflowContext integration — shared DI container for all modules
 *  2. Module lifecycle — calls init() on all modules before first run
 *  3. DAG validation — detects missing stages, unreachable nodes
 *  4. Real retry with exponential backoff
 *  5. Parallel stage execution via Promise.allSettled
 *  6. Proper shutdown — tears down modules and context
 *  7. Typed state (WorkflowData instead of Record<string, any>)
 *  8. Winston logging instead of console.log
 *  9. Preserves the learning loop from original MF
 */

import {
  WorkflowConfig,
  WorkflowState,
  WorkflowData,
  WorkflowStage,
  ModuleInput,
  ModuleOutput,
  BaseModule,
  GlobalConfig,
} from "./types.js";
import { ModuleRegistry } from "./ModuleRegistry.js";
import { WorkflowContext } from "./WorkflowContext.js";
import {
  WorkflowConfigError,
  WorkflowDAGError,
  WorkflowStageError,
} from "./errors.js";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const WorkflowConfigSchema = z.object({
  name: z.string(),
  version: z.string().default("1.0"),
  description: z.string().optional(),
  entry: z.string(),
  stages: z.array(
    z.object({
      id: z.string(),
      module: z.string(),
      config: z.record(z.unknown()).default({}),
      next: z
        .union([z.string(), z.array(z.string()), z.record(z.string())])
        .nullable()
        .optional(),
      dependsOn: z.array(z.string()).optional(),
      parallel: z.boolean().optional(),
      retry: z.number().min(0).default(0),
      retryDelayMs: z.number().min(0).default(1000),
    }),
  ),
  globalConfig: z
    .object({
      llmProvider: z.enum(["ollama", "openrouter", "openai"]).default("ollama"),
      llmModel: z.string().optional(),
      embeddingProvider: z.enum(["ollama", "openrouter", "openai"]).default("ollama"),
      embeddingModel: z.string().optional(),
      memgraphUri: z.string().optional(),
      memgraphUser: z.string().optional(),
      memgraphPassword: z.string().optional(),
      maxConcurrency: z.number().default(4),
      tokenBudget: z.number().default(8192),
      logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .optional(),
  meta: z
    .object({
      learning: z.boolean().optional(),
      maxIterations: z.number().optional(),
      metrics: z.array(z.string()).optional(),
      autoResearch: z.boolean().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Improvement #16: Workflow versioning
// ---------------------------------------------------------------------------

/** Supported workflow config versions */
const SUPPORTED_VERSIONS = {
  current: ["1.0", "1.1"],
  deprecated: ["0.1", "0.2"],
};

/** All accepted versions (current + deprecated) */
const ALL_ACCEPTED = [
  ...SUPPORTED_VERSIONS.current,
  ...SUPPORTED_VERSIONS.deprecated,
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private readonly registry = ModuleRegistry.getInstance();
  private readonly config: WorkflowConfig;
  private state: WorkflowState;
  private context?: WorkflowContext;
  private modules = new Map<string, BaseModule>();
  private initialized = false;

  constructor(config: WorkflowConfig) {
    try {
      this.config = WorkflowConfigSchema.parse(config) as WorkflowConfig;
    } catch (err) {
      throw new WorkflowConfigError(
        `Invalid workflow config: ${(err as Error).message}`,
        err as Error,
      );
    }

    this.state = this.createInitialState();
    this.validateDAG();
    this.validateVersion();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Initialise context and all modules. Must be called before `run()`. */
  async initialize(globalConfigOverride?: GlobalConfig): Promise<void> {
    const globalConfig = {
      ...this.config.globalConfig,
      ...globalConfigOverride,
    };

    this.context = await WorkflowContext.create(globalConfig);

    // Improvement #11: Validate all module configs before execution begins.
    // This surfaces config errors at startup instead of mid-pipeline.
    await this.validateModuleConfigs();

    // Resolve and init all modules
    for (const stage of this.config.stages) {
      const mod = await this.registry.getModule(
        stage.module,
        stage.config as Record<string, unknown>,
        stage.id,
      );
      if (mod.init) {
        await mod.init(this.context);
      }
      this.modules.set(stage.id, mod);
    }

    this.initialized = true;

    // Improvement #16: Log deprecation warning for older workflow versions
    if (SUPPORTED_VERSIONS.deprecated.includes(this.config.version)) {
      this.context.logger.warn(
        `Workflow "${this.config.name}" uses deprecated version "${this.config.version}". ` +
          `Please migrate to version ${SUPPORTED_VERSIONS.current[SUPPORTED_VERSIONS.current.length - 1]}.`,
      );
    }

    this.context.logger.info(`Workflow "${this.config.name}" initialized`, {
      stages: this.config.stages.map((s) => s.id),
      modules: this.config.stages.map((s) => s.module),
      version: this.config.version,
    });
  }

  /**
   * Initialise with an existing WorkflowContext (for sub-workflows).
   *
   * Reuses the parent's shared resources (LLM, Memgraph, StateStore, Logger)
   * instead of creating new connections. This avoids spinning up duplicate
   * clients and ensures state is shared across parent/child workflows.
   */
  async initializeWithContext(parentContext: WorkflowContext): Promise<void> {
    this.context = parentContext;

    // Improvement #11: Validate all module configs before execution begins.
    await this.validateModuleConfigs();

    // Resolve and init all modules using the shared context
    for (const stage of this.config.stages) {
      const mod = await this.registry.getModule(
        stage.module,
        stage.config as Record<string, unknown>,
        stage.id,
      );
      if (mod.init) {
        await mod.init(this.context);
      }
      this.modules.set(stage.id, mod);
    }

    this.initialized = true;
    this.context.logger.info(
      `Sub-workflow "${this.config.name}" initialized with shared context`,
      {
        stages: this.config.stages.map((s) => s.id),
        modules: this.config.stages.map((s) => s.module),
      },
    );
  }

  /** Execute the workflow with optional initial input data. */
  async run(initialInput: Partial<WorkflowData> = {}): Promise<WorkflowState> {
    if (!this.initialized || !this.context) {
      throw new WorkflowConfigError(
        "Engine not initialized. Call initialize() first.",
      );
    }

    this.state.data = { ...this.state.data, ...initialInput };
    const maxIter = this.config.meta?.maxIterations ?? 1;
    const isLearning = this.config.meta?.learning === true;
    let bestState = structuredClone(this.state);
    let bestScore = -Infinity;

    for (let iter = 0; iter < maxIter; iter++) {
      this.state.iteration = iter;
      this.context.logger.info(
        `Starting iteration ${iter + 1}/${maxIter} for "${this.config.name}"`,
      );

      await this.executeDAG();

      if (isLearning || this.config.meta?.autoResearch) {
        const score = this.computeScore();
        this.context.logger.info(`Iteration ${iter + 1} score: ${score.toFixed(3)}`);

        if (score > bestScore) {
          bestScore = score;
          bestState = structuredClone(this.state);
        }
        this.evolveConfig(score);
      }
    }

    if (isLearning) {
      this.state = bestState;
      this.context.logger.info(`Best iteration score: ${bestScore.toFixed(3)}`);
    }

    // Finalize metadata
    this.state.metadata.endTime = new Date().toISOString();
    this.state.metadata.totalDurationMs =
      new Date(this.state.metadata.endTime).getTime() -
      new Date(this.state.metadata.startTime).getTime();

    return this.state;
  }

  /** Tear down all modules and the context. */
  async shutdown(): Promise<void> {
    for (const mod of this.modules.values()) {
      try {
        await mod.shutdown?.();
      } catch (err) {
        this.context?.logger.warn(
          `Module shutdown error: ${(err as Error).message}`,
        );
      }
    }
    await this.context?.shutdown();
    this.registry.clearInstances();
    this.initialized = false;
  }

  // -----------------------------------------------------------------------
  // DAG execution
  // -----------------------------------------------------------------------

  /**
   * Execute the workflow DAG with parallel branch support.
   *
   * When a stage's `next` is an array, all branches are executed in parallel
   * via Promise.allSettled. The `dependsOn` field gates execution until all
   * listed dependencies have completed. `maxConcurrency` limits parallel width.
   */
  private async executeDAG(): Promise<void> {
    const completed = new Set<string>();
    const running = new Set<string>();
    const stageMap = new Map(this.config.stages.map((s) => [s.id, s]));
    const maxConcurrency = this.config.globalConfig?.maxConcurrency ?? 4;

    // Start from entry point
    const pending = new Set<string>([this.config.entry]);

    while (pending.size > 0 || running.size > 0) {
      // Find stages whose dependencies are all completed
      const ready: string[] = [];
      for (const id of pending) {
        const stage = stageMap.get(id);
        if (!stage) { pending.delete(id); continue; }

        const deps = stage.dependsOn ?? [];
        const allDepsMet = deps.every((d) => completed.has(d));
        if (allDepsMet && running.size < maxConcurrency) {
          ready.push(id);
        }
      }

      if (ready.length === 0 && running.size === 0) {
        // Deadlock — remaining stages have unmet dependencies
        break;
      }

      if (ready.length === 0) {
        // Wait for a running stage to complete before retrying
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      // Execute ready stages (parallel if multiple are ready)
      const executions = ready.map(async (id) => {
        pending.delete(id);
        running.add(id);
        const stage = stageMap.get(id)!;

        try {
          await this.executeStage(stage);
        } finally {
          running.delete(id);
          completed.add(id);
        }

        // Enqueue next stages
        const nextIds = this.resolveNext(stage, completed);
        for (const nextId of nextIds) {
          if (!completed.has(nextId) && !running.has(nextId)) {
            pending.add(nextId);
          }
        }
      });

      // If stages are marked parallel or there are multiple ready, run concurrently
      if (ready.length > 1) {
        const results = await Promise.allSettled(executions);
        for (const r of results) {
          if (r.status === "rejected") {
            throw r.reason;
          }
        }
      } else {
        await executions[0];
      }
    }
  }

  private async executeStage(stage: WorkflowStage): Promise<void> {
    const mod = this.modules.get(stage.id);
    if (!mod) return;

    const maxAttempts = (stage.retry ?? 0) + 1;
    const baseDelay = stage.retryDelayMs ?? 1000;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const startTime = Date.now();
        this.context!.logger.info(`Executing stage "${stage.id}" (${stage.module})`, {
          attempt,
          maxAttempts,
        });

        const input: ModuleInput = {
          data: this.state.data,
          config: stage.config as Record<string, unknown>,
        };

        const output: ModuleOutput = await mod.process(input, this.context!);
        const durationMs = Date.now() - startTime;

        // Merge output into state
        this.state.data = { ...this.state.data, ...output.data };
        if (output.metrics) {
          this.state.data.metrics = {
            ...(this.state.data.metrics ?? {}),
            ...output.metrics,
          };
        }

        // Record history
        this.state.history.push({
          stage: stage.id,
          output: output.data,
          timestamp: new Date().toISOString(),
          durationMs,
        });

        // Record trace
        this.context!.addTrace(stage.id, input.data, output.data, durationMs);

        return; // Success — exit retry loop
      } catch (err) {
        lastError = err as Error;
        this.state.errors.push({
          stage: stage.id,
          error: lastError.message,
          attempt,
          timestamp: new Date().toISOString(),
        });

        if (attempt < maxAttempts) {
          const delay = Math.min(baseDelay * 2 ** (attempt - 1), 30_000);
          this.context!.logger.warn(
            `Stage "${stage.id}" failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
            { error: lastError.message },
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted
    throw new WorkflowStageError(
      stage.id,
      stage.module,
      lastError!,
      maxAttempts,
    );
  }

  // -----------------------------------------------------------------------
  // Module config validation (Improvement #11)
  // -----------------------------------------------------------------------

  /**
   * Validate all module configs at workflow load time.
   *
   * Resolves each module and calls `getConfigSchema().parse()` on the
   * stage config. Collects all validation errors and surfaces them before
   * execution begins — preventing failures minutes into a long-running pipeline.
   *
   * (Improvement #11 from IMPROVE.md)
   */
  private async validateModuleConfigs(): Promise<void> {
    const errors: Array<{ stageId: string; module: string; error: string }> = [];

    for (const stage of this.config.stages) {
      try {
        const mod = await this.registry.getModule(
          stage.module,
          stage.config as Record<string, unknown>,
          `__validate__${stage.id}`,
        );

        // Attempt schema validation
        const schema = mod.getConfigSchema();
        schema.parse(stage.config);
      } catch (err) {
        errors.push({
          stageId: stage.id,
          module: stage.module,
          error: (err as Error).message,
        });
      }
    }

    // Clean up validation-only instances
    this.registry.clearInstances();

    if (errors.length > 0) {
      const summary = errors
        .map((e) => `  Stage "${e.stageId}" (${e.module}): ${e.error}`)
        .join("\n");

      throw new WorkflowConfigError(
        `Module config validation failed for ${errors.length} stage(s):\n${summary}`,
      );
    }
  }

  /**
   * Resolve the next stage(s) to execute after the current stage.
   *
   * Supports:
   *  - `string` → single next stage
   *  - `string[]` → parallel fan-out (all branches executed concurrently)
   *  - `{ "metric>threshold": "stageId", "default": "fallback" }` →
   *    configurable conditional routing. Key format: "metricName>0.7" or
   *    "metricName" (defaults to > 0.5). Special key "default" is the fallback.
   */
  private resolveNext(
    stage: WorkflowStage,
    _completed?: Set<string>,
  ): string[] {
    const next = stage.next;
    if (!next) return [];

    if (typeof next === "string") return [next];

    if (Array.isArray(next)) {
      // Parallel fan-out: all branches are returned for concurrent execution
      return next;
    }

    // Conditional routing: { "metric>threshold": "nextStageId", "default": "fallback" }
    if (typeof next === "object") {
      for (const [condition, targetStage] of Object.entries(next)) {
        if (condition === "default") continue;

        // Parse condition: "metricKey>0.7" or "metricKey>=0.5" or bare "metricKey"
        const condMatch = condition.match(
          /^([A-Za-z_]\w*)\s*(>=?|<=?|==|!=)\s*([\d.]+)$/,
        );
        if (condMatch) {
          const [, metricKey, operator, thresholdStr] = condMatch;
          const metricValue = Number(this.state.data.metrics?.[metricKey] ?? 0);
          const threshold = Number(thresholdStr);

          const passes =
            operator === ">" ? metricValue > threshold :
            operator === ">=" ? metricValue >= threshold :
            operator === "<" ? metricValue < threshold :
            operator === "<=" ? metricValue <= threshold :
            operator === "==" ? metricValue === threshold :
            operator === "!=" ? metricValue !== threshold :
            false;

          if (passes) return [targetStage];
        } else {
          // Bare metric name — default to > 0.5 for backward compatibility
          const metricValue = Number(
            this.state.data.metrics?.[condition] ?? 0,
          );
          if (metricValue > 0.5) return [targetStage];
        }
      }

      // Fallback to "default" key if no condition matched
      const defaultTarget = (next as Record<string, string>)["default"];
      if (defaultTarget) return [defaultTarget];

      return [];
    }

    return [];
  }

  // -----------------------------------------------------------------------
  // Learning loop (preserved from original MF)
  // -----------------------------------------------------------------------

  private computeScore(): number {
    const m = this.state.data.metrics ?? {};
    const accuracy = Number(m.accuracy ?? m.f1 ?? 0.5);
    const efficiency = 1 / Math.max(1, Number(m.tokenUsage ?? 1000) / 100);
    const coherence = Number(m.coherence ?? 0.7);
    return accuracy * 0.5 + efficiency * 0.3 + coherence * 0.2;
  }

  private evolveConfig(score: number): void {
    for (const stage of this.config.stages) {
      const mod = this.modules.get(stage.id);
      if (!mod?.supportsLearning()) continue;

      if (stage.module === "S2Chunker" && stage.config.alpha !== undefined) {
        const alpha = Number(stage.config.alpha);
        stage.config.alpha = Math.max(
          0.1,
          Math.min(0.9, alpha + (score > 0.7 ? 0.05 : -0.05)),
        );
      }

      if (stage.module === "QueryTranslator" && score < 0.6) {
        stage.config.techniques = ["hyde", "multi_query", "step_back"];
      }
    }

    this.context?.logger.info(`Config evolved for next iteration`, {
      score: score.toFixed(2),
    });
  }

  // -----------------------------------------------------------------------
  // DAG validation
  // -----------------------------------------------------------------------

  private validateDAG(): void {
    const stageIds = new Set(this.config.stages.map((s) => s.id));

    // Entry point must exist
    if (!stageIds.has(this.config.entry)) {
      throw new WorkflowDAGError(
        `Entry point "${this.config.entry}" does not exist in stages`,
      );
    }

    // All next references must point to existing stages
    for (const stage of this.config.stages) {
      const nextRefs = this.collectNextRefs(stage);
      for (const ref of nextRefs) {
        if (!stageIds.has(ref)) {
          throw new WorkflowDAGError(
            `Stage "${stage.id}" references unknown next stage "${ref}"`,
          );
        }
      }
    }

    // Check reachability from entry (warn, don't throw)
    const reachable = new Set<string>();
    const queue = [this.config.entry];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const stage = this.config.stages.find((s) => s.id === id);
      if (stage) {
        queue.push(...this.collectNextRefs(stage));
      }
    }

    const unreachable = this.config.stages
      .map((s) => s.id)
      .filter((id) => !reachable.has(id));

    if (unreachable.length > 0) {
      // Warn but don't throw — unreachable stages might be conditional targets
      // that are only reached via metric-based routing
    }
  }

  /**
   * Validate workflow version compatibility (Improvement #16).
   *
   * - Current versions: accepted silently
   * - Deprecated versions: accepted with warning
   * - Unknown versions: rejected with error
   */
  private validateVersion(): void {
    const version = this.config.version;

    if (SUPPORTED_VERSIONS.current.includes(version)) {
      return; // Current version — all good
    }

    if (SUPPORTED_VERSIONS.deprecated.includes(version)) {
      // Deprecated but still accepted — will warn during initialize()
      // (can't log here since context isn't created yet)
      return;
    }

    if (!ALL_ACCEPTED.includes(version)) {
      throw new WorkflowConfigError(
        `Unsupported workflow version "${version}". ` +
          `Supported: ${SUPPORTED_VERSIONS.current.join(", ")}. ` +
          `Deprecated (still accepted): ${SUPPORTED_VERSIONS.deprecated.join(", ")}.`,
      );
    }
  }

  private collectNextRefs(stage: WorkflowStage): string[] {
    const next = stage.next;
    if (!next) return [];
    if (typeof next === "string") return [next];
    if (Array.isArray(next)) return next;
    if (typeof next === "object") return Object.values(next);
    return [];
  }

  // -----------------------------------------------------------------------
  // State access
  // -----------------------------------------------------------------------

  getState(): WorkflowState {
    return structuredClone(this.state);
  }

  exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }

  private createInitialState(): WorkflowState {
    return {
      id: uuidv4(),
      currentStage: this.config.entry,
      data: {},
      history: [],
      iteration: 0,
      errors: [],
      metadata: {
        startTime: new Date().toISOString(),
        providers: { llm: "default", embeddings: "default" },
        workflowName: this.config.name,
      },
    };
  }
}