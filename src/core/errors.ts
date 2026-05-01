/**
 * MemFlow Error Hierarchy
 *
 * Structured error types that replace raw `Error` throws throughout the
 * codebase. Every error carries enough context for observability (stage,
 * module, cause) without leaking implementation details.
 */

export class MemFlowError extends Error {
  readonly code: string;
  readonly cause?: Error;

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.name = "MemFlowError";
    this.code = code;
    this.cause = cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }
}

/** Thrown when a workflow stage fails during execution */
export class WorkflowStageError extends MemFlowError {
  readonly stageId: string;
  readonly moduleName: string;
  readonly attempt: number;

  constructor(
    stageId: string,
    moduleName: string,
    cause: Error,
    attempt = 1,
  ) {
    super(
      `Stage "${stageId}" (module: ${moduleName}) failed on attempt ${attempt}: ${cause.message}`,
      "STAGE_EXECUTION_FAILED",
      cause,
    );
    this.name = "WorkflowStageError";
    this.stageId = stageId;
    this.moduleName = moduleName;
    this.attempt = attempt;
  }
}

/** Thrown when workflow JSON config is invalid */
export class WorkflowConfigError extends MemFlowError {
  constructor(message: string, cause?: Error) {
    super(message, "INVALID_WORKFLOW_CONFIG", cause);
    this.name = "WorkflowConfigError";
  }
}

/** Thrown when a DAG cycle or unreachable stage is detected */
export class WorkflowDAGError extends MemFlowError {
  readonly unreachableStages?: string[];
  readonly cycleAt?: string;

  constructor(
    message: string,
    details?: { unreachableStages?: string[]; cycleAt?: string },
  ) {
    super(message, "INVALID_DAG");
    this.name = "WorkflowDAGError";
    this.unreachableStages = details?.unreachableStages;
    this.cycleAt = details?.cycleAt;
  }
}

/** Thrown when a module is not found in the registry */
export class ModuleNotFoundError extends MemFlowError {
  readonly moduleName: string;
  readonly available: string[];

  constructor(moduleName: string, available: string[]) {
    super(
      `Module "${moduleName}" not registered. Available: ${available.join(", ")}`,
      "MODULE_NOT_FOUND",
    );
    this.name = "ModuleNotFoundError";
    this.moduleName = moduleName;
    this.available = available;
  }
}

/** Thrown when a provider (LLM, Embeddings, Memgraph) fails */
export class ProviderError extends MemFlowError {
  readonly provider: string;

  constructor(provider: string, message: string, cause?: Error) {
    super(`Provider "${provider}": ${message}`, "PROVIDER_FAILED", cause);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

/** Thrown when Memgraph operations fail */
export class MemgraphError extends ProviderError {
  readonly query?: string;

  constructor(message: string, cause?: Error, query?: string) {
    super("memgraph", message, cause);
    this.name = "MemgraphError";
    this.query = query;
  }
}
