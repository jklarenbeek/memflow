/**
 * ACP Types — Zod schemas and TypeScript types for Agent Client Protocol
 *
 * Implements a subset of the ACP spec focused on session lifecycle and streaming.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON-RPC base (same as MCP)
// ---------------------------------------------------------------------------

export const JSONRPCRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

export const JSONRPCResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export const JSONRPCNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

export type JSONRPCRequest = z.infer<typeof JSONRPCRequestSchema>;
export type JSONRPCResponse = z.infer<typeof JSONRPCResponseSchema>;
export type JSONRPCNotification = z.infer<typeof JSONRPCNotificationSchema>;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export const InitializeRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("initialize"),
  params: z.object({
    protocolVersion: z.string(),
    capabilities: z.record(z.unknown()).default({}),
    clientInfo: z.object({
      name: z.string(),
      version: z.string(),
    }),
  }),
});

export const InitializeResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    protocolVersion: z.string(),
    capabilities: z.record(z.unknown()).default({}),
    serverInfo: z.object({
      name: z.string(),
      version: z.string(),
    }),
  }),
});

export type InitializeRequest = z.infer<typeof InitializeRequestSchema>;
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export const SessionNewRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("session/new"),
  params: z.object({
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
  }).optional(),
});

export const SessionNewResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    sessionId: z.string(),
  }),
});

export type SessionNewRequest = z.infer<typeof SessionNewRequestSchema>;
export type SessionNewResponse = z.infer<typeof SessionNewResponseSchema>;

export const SessionPromptRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("session/prompt"),
  params: z.object({
    sessionId: z.string(),
    prompt: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      uri: z.string().optional(),
      mimeType: z.string().optional(),
    })),
  }),
});

export const SessionPromptResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    stopReason: z.enum(["end_turn", "cancelled", "max_tokens", "refusal"]),
    answer: z.string().optional(),
  }),
});

export type SessionPromptRequest = z.infer<typeof SessionPromptRequestSchema>;
export type SessionPromptResponse = z.infer<typeof SessionPromptResponseSchema>;

export const SessionCancelNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("session/cancel"),
  params: z.object({
    sessionId: z.string(),
  }),
});

export type SessionCancelNotification = z.infer<typeof SessionCancelNotificationSchema>;

export const SessionCloseRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("session/close"),
  params: z.object({
    sessionId: z.string(),
  }),
});

export type SessionCloseRequest = z.infer<typeof SessionCloseRequestSchema>;

export const SessionListRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("session/list"),
  params: z.object({}).optional(),
});

export const SessionListResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    sessions: z.array(z.object({
      sessionId: z.string(),
      status: z.enum(["active", "closed"]),
      createdAt: z.string(),
    })),
  }),
});

export type SessionListRequest = z.infer<typeof SessionListRequestSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

// ---------------------------------------------------------------------------
// Session update (server → client notification)
// ---------------------------------------------------------------------------

export const SessionUpdateSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("session/update"),
  params: z.object({
    sessionId: z.string(),
    update: z.object({
      sessionUpdate: z.string(),
      content: z.unknown().optional(),
      toolCallId: z.string().optional(),
      status: z.string().optional(),
      entries: z.array(z.unknown()).optional(),
    }),
  }),
});

export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export const ACPErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  SessionNotFound: -32001,
  SessionExists: -32002,
} as const;

export function makeErrorResponse(
  id: string | number,
  code: number,
  message: string,
  data?: unknown,
): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

export function makeSuccessResponse(
  id: string | number,
  result: Record<string, unknown>,
): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}
