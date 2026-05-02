/**
 * GMPL Error Hierarchy — structured error types for pattern failures
 *
 * All GMPL-specific errors extend the base GmplError, which adds:
 *  - `code`: machine-readable error identifier (for metrics / alerting)
 *  - `context`: key-value bag of contextual data for debugging
 *  - `cause`: optional upstream Error for chained diagnostics
 *
 * Design: mirrors the discriminated union pattern used in core/types.ts.
 * Consumers can `instanceof` check or switch on `error.code`.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export class GmplError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  override readonly cause?: Error;

  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(message);
    this.name = "GmplError";
    this.code = code;
    this.context = context;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Registry errors
// ---------------------------------------------------------------------------

/** Thrown when a pattern ID cannot be resolved from PatternRegistry */
export class PatternNotFoundError extends GmplError {
  constructor(patternId: string, available: string[] = []) {
    super(
      "PATTERN_NOT_FOUND",
      `Pattern "${patternId}" not found in PatternRegistry. ` +
        (available.length > 0 ? `Available: ${available.join(", ")}` : "Registry is empty."),
      { patternId, available },
    );
    this.name = "PatternNotFoundError";
  }
}

/** Thrown when a role ID cannot be resolved from RoleRegistry */
export class RoleNotFoundError extends GmplError {
  constructor(roleId: string, available: string[] = []) {
    super(
      "ROLE_NOT_FOUND",
      `Role "${roleId}" not found in RoleRegistry. ` +
        (available.length > 0 ? `Available: ${available.join(", ")}` : "Registry is empty."),
      { roleId, available },
    );
    this.name = "RoleNotFoundError";
  }
}

/** Thrown when a domain adapter is not registered */
export class DomainNotRegisteredError extends GmplError {
  constructor(domainId: string, available: string[] = []) {
    super(
      "DOMAIN_NOT_REGISTERED",
      `Domain adapter "${domainId}" not registered. ` +
        (available.length > 0 ? `Available: ${available.join(", ")}` : "No adapters registered."),
      { domainId, available },
    );
    this.name = "DomainNotRegisteredError";
  }
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

/** Thrown when a pattern's config, input, or output contract fails validation */
export class PatternValidationError extends GmplError {
  constructor(patternId: string, field: string, details: string, cause?: Error) {
    super(
      "PATTERN_VALIDATION",
      `Pattern "${patternId}" has invalid ${field}: ${details}`,
      { patternId, field },
      cause,
    );
    this.name = "PatternValidationError";
  }
}

// ---------------------------------------------------------------------------
// Composition errors
// ---------------------------------------------------------------------------

/** Thrown when pattern composition fails (e.g., empty stages, missing refs) */
export class CompositionError extends GmplError {
  constructor(compositionName: string, details: string, cause?: Error) {
    super(
      "COMPOSITION_ERROR",
      `Composition "${compositionName}" failed: ${details}`,
      { compositionName },
      cause,
    );
    this.name = "CompositionError";
  }
}

// ---------------------------------------------------------------------------
// Runtime errors
// ---------------------------------------------------------------------------

/** Thrown when outcome memory resolution fails */
export class OutcomeResolutionError extends GmplError {
  constructor(pendingId: string, details: string, cause?: Error) {
    super(
      "OUTCOME_RESOLUTION",
      `Outcome resolution for pending decision "${pendingId}" failed: ${details}`,
      { pendingId },
      cause,
    );
    this.name = "OutcomeResolutionError";
  }
}

/** Thrown when debate or Delphi convergence fails or stalls */
export class ConvergenceError extends GmplError {
  constructor(patternId: string, rounds: number, details: string) {
    super(
      "CONVERGENCE_FAILURE",
      `Convergence failure in pattern "${patternId}" after ${rounds} rounds: ${details}`,
      { patternId, rounds },
    );
    this.name = "ConvergenceError";
  }
}
