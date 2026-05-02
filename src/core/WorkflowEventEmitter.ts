/**
 * WorkflowEventEmitter — typed event system for workflow streaming
 *
 * Wraps Node.js's native EventEmitter with strong typing for StreamEvent
 * discriminated union types. This decouples event production (WorkflowEngine)
 * from consumption (SSE endpoint, logger, metrics collector, tests).
 *
 * Design decisions:
 *  - Uses the native `events` module (built-in, zero dependencies)
 *  - Type-safe `on()` / `once()` / `emit()` via mapped event names
 *  - Each StreamEvent `type` field doubles as the event name
 *  - Wildcard `*` listener receives ALL events for pass-through consumers
 *  - Provides `toAsyncGenerator()` for backward-compatible AsyncGenerator usage
 *
 * Usage:
 *   const emitter = new WorkflowEventEmitter();
 *   emitter.on('stage:progress', (event) => { ... });  // typed!
 *   emitter.on('*', (event) => { ... });                // all events
 *   const generator = emitter.toAsyncGenerator();       // AsyncGenerator<StreamEvent>
 */

import { EventEmitter } from "events";
import type {
  StreamEvent,
  StreamEventWorkflowStart,
  StreamEventStageStart,
  StreamEventStageProgress,
  StreamEventStageComplete,
  StreamEventStageError,
  StreamEventWorkflowComplete,
  StreamEventWorkflowError,
  StreamEventPatternEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Type-safe event map
// ---------------------------------------------------------------------------

/**
 * Maps StreamEvent `type` values to their corresponding event interfaces.
 * Enables type-safe `on()` / `once()` / `emit()` calls.
 */
export interface WorkflowEventMap {
  "workflow:start": StreamEventWorkflowStart;
  "stage:start": StreamEventStageStart;
  "stage:progress": StreamEventStageProgress;
  "stage:complete": StreamEventStageComplete;
  "stage:error": StreamEventStageError;
  "workflow:complete": StreamEventWorkflowComplete;
  "workflow:error": StreamEventWorkflowError;
  /** GMPL pattern-level events (debate:*, analysis:*, etc.) */
  "pattern:event": StreamEventPatternEvent;
  /** Wildcard — receives ALL events for pass-through consumers */
  "*": StreamEvent;
}

// ---------------------------------------------------------------------------
// Typed emitter
// ---------------------------------------------------------------------------

export class WorkflowEventEmitter {
  private readonly ee = new EventEmitter();

  /** Max listeners per event (raised from default 10 for multi-consumer use) */
  constructor(maxListeners = 50) {
    this.ee.setMaxListeners(maxListeners);
  }

  // -----------------------------------------------------------------------
  // Type-safe subscription
  // -----------------------------------------------------------------------

  /**
   * Register a typed listener for a specific event type.
   *
   * @example
   *   emitter.on('stage:progress', (event) => {
   *     console.log(event.token);  // TypeScript knows this is StreamEventStageProgress
   *   });
   */
  on<K extends keyof WorkflowEventMap>(
    event: K,
    listener: (data: WorkflowEventMap[K]) => void,
  ): this {
    this.ee.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Register a one-time typed listener.
   */
  once<K extends keyof WorkflowEventMap>(
    event: K,
    listener: (data: WorkflowEventMap[K]) => void,
  ): this {
    this.ee.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Remove a specific listener.
   */
  off<K extends keyof WorkflowEventMap>(
    event: K,
    listener: (data: WorkflowEventMap[K]) => void,
  ): this {
    this.ee.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Remove all listeners, optionally for a specific event.
   */
  removeAllListeners(event?: keyof WorkflowEventMap): this {
    if (event) {
      this.ee.removeAllListeners(event);
    } else {
      this.ee.removeAllListeners();
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  /**
   * Emit a typed StreamEvent.
   *
   * Emits on both the specific event channel (e.g., `stage:progress`)
   * AND the wildcard `*` channel, so wildcard listeners always receive
   * every event without needing to subscribe to each type individually.
   */
  emit(event: StreamEvent): boolean {
    const specific = this.ee.emit(event.type, event);
    const wildcard = this.ee.emit("*", event);
    return specific || wildcard;
  }

  // -----------------------------------------------------------------------
  // AsyncGenerator bridge
  // -----------------------------------------------------------------------

  /**
   * Convert this EventEmitter into an AsyncGenerator for backward-compatible
   * consumption (e.g., existing `runStream()` callers).
   *
   * The generator yields all events received via the wildcard `*` channel.
   * It completes when a `workflow:complete` or `workflow:error` event is
   * received, or when `abort()` is called.
   *
   * @param abortSignal — optional AbortSignal for client disconnect
   *
   * @example
   *   for await (const event of emitter.toAsyncGenerator()) {
   *     console.log(event.type, event);
   *   }
   */
  async *toAsyncGenerator(
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    // Buffered queue pattern: events are pushed into the queue,
    // and the generator pulls from it. This handles backpressure
    // and ensures no events are dropped between yields.
    const queue: StreamEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const onEvent = (event: StreamEvent) => {
      queue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const onTerminal = () => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    // Subscribe to all events via wildcard
    this.on("*", onEvent);

    // Terminal events signal generator completion
    this.on("workflow:complete", onTerminal);
    this.on("workflow:error", onTerminal);

    // Handle client abort
    const onAbort = () => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        // Drain all queued events
        while (queue.length > 0) {
          yield queue.shift()!;
        }

        // If terminal event was received and queue is drained, we're done
        if (done) return;

        // Wait for next event
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      // Cleanup
      this.off("*", onEvent);
      this.off("workflow:complete", onTerminal);
      this.off("workflow:error", onTerminal);
      abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  /** Number of listeners for a specific event type. */
  listenerCount(event: keyof WorkflowEventMap): number {
    return this.ee.listenerCount(event);
  }

  /** All event names that have at least one listener. */
  eventNames(): (keyof WorkflowEventMap)[] {
    return this.ee.eventNames() as (keyof WorkflowEventMap)[];
  }
}
