/**
 * ACP Server — JSON-RPC 2.0 dispatcher for Agent Client Protocol
 *
 * Handles initialize, session/new, session/prompt, session/cancel, session/close, session/list.
 */

import {
  JSONRPCRequestSchema,
  type JSONRPCRequest,
  type JSONRPCResponse,
  makeErrorResponse,
  makeSuccessResponse,
  ACPErrorCode,
} from "./ACPTypes.js";
import { ACPSessionManager } from "./ACPSession.js";
import type { GlobalConfig, WorkflowConfig } from "../core/types.js";

export class ACPServer {
  private readonly sessions: ACPSessionManager;
  private initialized = false;

  constructor(globalConfig: GlobalConfig, defaultWorkflow: WorkflowConfig) {
    this.sessions = new ACPSessionManager(globalConfig, defaultWorkflow);
  }

  /** Dispatch a JSON-RPC request to the appropriate handler. */
  async dispatch(request: unknown): Promise<JSONRPCResponse> {
    let parsed: JSONRPCRequest;
    try {
      parsed = JSONRPCRequestSchema.parse(request);
    } catch (err) {
      return makeErrorResponse(
        (request as any)?.id ?? 0,
        ACPErrorCode.ParseError,
        `Invalid JSON-RPC request: ${(err as Error).message}`,
      );
    }

    const { id = 0, method, params = {} } = parsed;

    try {
      switch (method) {
        case "initialize":
          return this.handleInitialize(id);

        case "session/new":
          return await this.handleSessionNew(id, params as Record<string, unknown>);

        case "session/prompt":
          return await this.handleSessionPrompt(id, params as Record<string, unknown>);

        case "session/cancel":
          return this.handleSessionCancel(params as Record<string, unknown>);

        case "session/close":
          return await this.handleSessionClose(id, params as Record<string, unknown>);

        case "session/list":
          return this.handleSessionList(id);

        default:
          return makeErrorResponse(
            id,
            ACPErrorCode.MethodNotFound,
            `Method not found: ${method}`,
          );
      }
    } catch (err) {
      return makeErrorResponse(
        id,
        ACPErrorCode.InternalError,
        (err as Error).message,
      );
    }
  }

  /** Get the session manager for SSE subscriptions. */
  getSessionManager(): ACPSessionManager {
    return this.sessions;
  }

  private handleInitialize(id: string | number): JSONRPCResponse {
    this.initialized = true;
    return makeSuccessResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        loadSession: true,
        promptCapabilities: { text: true, embeddedContext: true, image: false, audio: false },
        sessionCapabilities: { close: true, list: true, resume: false },
      },
      serverInfo: { name: "memflow-acp", version: "0.5.0" },
    });
  }

  private async handleSessionNew(id: string | number, params: Record<string, unknown>): Promise<JSONRPCResponse> {
    const sessionId = await this.sessions.createSession(params.sessionId as string | undefined);
    return makeSuccessResponse(id, { sessionId });
  }

  private async handleSessionPrompt(id: string | number, params: Record<string, unknown>): Promise<JSONRPCResponse> {
    const sessionId = params.sessionId as string;
    const promptBlocks = params.prompt as Array<{ type: string; text?: string }> | undefined;

    if (!sessionId || typeof sessionId !== "string") {
      return makeErrorResponse(id, ACPErrorCode.InvalidParams, "Missing required param: sessionId");
    }

    const promptText = promptBlocks?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";

    const result = await this.sessions.prompt(sessionId, promptText);
    return makeSuccessResponse(id, {
      stopReason: result.stopReason,
      answer: result.answer,
    });
  }

  private handleSessionCancel(params: Record<string, unknown>): JSONRPCResponse {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      return makeErrorResponse(0, ACPErrorCode.InvalidParams, "Missing required param: sessionId");
    }
    this.sessions.cancel(sessionId);
    return makeSuccessResponse(0, { cancelled: true });
  }

  private async handleSessionClose(id: string | number, params: Record<string, unknown>): Promise<JSONRPCResponse> {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      return makeErrorResponse(id, ACPErrorCode.InvalidParams, "Missing required param: sessionId");
    }
    await this.sessions.close(sessionId);
    return makeSuccessResponse(id, { closed: true });
  }

  private handleSessionList(id: string | number): JSONRPCResponse {
    const sessions = this.sessions.listSessions();
    return makeSuccessResponse(id, { sessions });
  }
}
