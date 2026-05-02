/**
 * emitPatternEvent — shared utility for GMPL pattern event emission
 *
 * All GMPL modules call this function to emit typed `pattern:event`
 * StreamEvents through the WorkflowContext's event emitter.
 *
 * Replaces the duck-typed `(context as any).eventEmitter` access
 * that DebateModule originally used. Now all modules go through
 * `context.eventEmitter` (injected by WorkflowEngine).
 *
 * No-op when the emitter is not available (e.g., non-streaming
 * execution paths or test contexts without emitter injection).
 */

import type { WorkflowContext } from "../core/WorkflowContext.js";
import type { StreamEventPatternEvent } from "../core/types.js";

/**
 * Emit a GMPL pattern-level event via the WorkflowContext's event emitter.
 *
 * @param context   - The WorkflowContext (or unknown for type-safe modules)
 * @param patternId - Pattern identifier from PatternRegistry (e.g. 'structured_debate')
 * @param eventName - Pattern-specific event name (e.g. 'debate:round_start')
 * @param stageId   - Module/stage name where the event originated
 * @param payload   - Free-form event data
 */
export function emitPatternEvent(
  context: unknown,
  patternId: string,
  eventName: string,
  stageId: string,
  payload: Record<string, unknown>,
): void {
  if (!context) return;
  const ctx = context as WorkflowContext;
  if (ctx.eventEmitter && typeof ctx.eventEmitter.emit === "function") {
    const event: StreamEventPatternEvent = {
      type: "pattern:event",
      patternId,
      eventName,
      stageId,
      payload,
      timestamp: new Date().toISOString(),
    };
    ctx.eventEmitter.emit(event);
  }
}
