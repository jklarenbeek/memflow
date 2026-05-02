/**
 * ACP Session — binds a WorkflowEngine to an ACP session
 *
 * Manages the engine lifecycle, event subscriptions, and abort control.
 */

import { WorkflowEngine } from "../core/WorkflowEngine.js";
import type { GlobalConfig, WorkflowConfig, StreamEvent } from "../core/types.js";
import { mapEventToUpdate } from "./ACPEventMapper.js";
import type { SessionUpdate } from "./ACPTypes.js";

export interface ACPSessionState {
  sessionId: string;
  engine: WorkflowEngine;
  createdAt: string;
  closed: boolean;
  abortController: AbortController;
  subscribers: Set<(update: SessionUpdate) => void>;
}

export class ACPSessionManager {
  private readonly sessions = new Map<string, ACPSessionState>();
  private readonly globalConfig: GlobalConfig;
  private readonly defaultWorkflow: WorkflowConfig;

  constructor(globalConfig: GlobalConfig, defaultWorkflow: WorkflowConfig) {
    this.globalConfig = globalConfig;
    this.defaultWorkflow = defaultWorkflow;
  }

  /** Create a new session with a fresh WorkflowEngine. */
  async createSession(sessionId?: string): Promise<string> {
    const id = sessionId ?? crypto.randomUUID();
    const engine = new WorkflowEngine(this.defaultWorkflow);
    await engine.initialize(this.globalConfig);

    const state: ACPSessionState = {
      sessionId: id,
      engine,
      createdAt: new Date().toISOString(),
      closed: false,
      abortController: new AbortController(),
      subscribers: new Set(),
    };

    // Subscribe to workflow events and forward as ACP updates
    engine.events.on("*", (event: StreamEvent) => {
      const mapped = mapEventToUpdate(event);
      if (mapped) {
        const notification: SessionUpdate = {
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: id, ...mapped },
        };
        for (const sub of state.subscribers) {
          try { sub(notification); } catch { /* ignore subscriber errors */ }
        }
      }
    });

    this.sessions.set(id, state);
    return id;
  }

  /** Get an active session by ID. */
  getSession(sessionId: string): ACPSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** List all sessions (active and closed). */
  listSessions(): Array<{ sessionId: string; status: "active" | "closed"; createdAt: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      status: s.closed ? "closed" : "active",
      createdAt: s.createdAt,
    }));
  }

  /** Run a prompt on a session. Returns the final answer. */
  async prompt(sessionId: string, promptText: string): Promise<{ answer: string; stopReason: string }> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) {
      throw new Error(`Session not found or closed: ${sessionId}`);
    }

    const { engine, abortController } = state;

    try {
      const result = await engine.run({ query: promptText });
      return {
        answer: result.data.finalAnswer ?? "",
        stopReason: "end_turn",
      };
    } catch (err) {
      if (abortController.signal.aborted) {
        return { answer: "", stopReason: "cancelled" };
      }
      throw err;
    }
  }

  /** Cancel an active session's current workflow. */
  cancel(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.abortController.abort();
    }
  }

  /** Close a session and clean up resources. */
  async close(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.closed = true;
    state.subscribers.clear();
    await state.engine.shutdown();
  }

  /** Subscribe to session updates. */
  subscribe(sessionId: string, callback: (update: SessionUpdate) => void): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.subscribers.add(callback);
    }
  }

  /** Unsubscribe from session updates. */
  unsubscribe(sessionId: string, callback: (update: SessionUpdate) => void): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.subscribers.delete(callback);
    }
  }

  /** Clean up closed sessions older than maxAgeMs. */
  gc(maxAgeMs = 3600_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, state] of this.sessions) {
      if (state.closed && new Date(state.createdAt).getTime() < cutoff) {
        this.sessions.delete(id);
      }
    }
  }
}
