/**
 * MCP Types — Zod schemas and TypeScript types for Model Context Protocol
 *
 * Implements MCP protocol version 2024-11-05 (JSON-RPC 2.0 over Streamable HTTP).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON-RPC base
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
    capabilities: z.object({
      tools: z.object({}).optional(),
    }).default({}),
    serverInfo: z.object({
      name: z.string(),
      version: z.string(),
    }),
  }),
});

export type InitializeRequest = z.infer<typeof InitializeRequestSchema>;
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolsListRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/list"),
  params: z.object({}).optional(),
});

export const ToolsListResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    tools: z.array(ToolDefinitionSchema),
  }),
});

export type ToolsListRequest = z.infer<typeof ToolsListRequestSchema>;
export type ToolsListResponse = z.infer<typeof ToolsListResponseSchema>;

// ---------------------------------------------------------------------------
// Tool Call
// ---------------------------------------------------------------------------

export const ToolCallRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
    meta: z.record(z.unknown()).optional(),
  }),
});

export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ErrorContentSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export const ToolCallResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    content: z.array(z.union([TextContentSchema, ErrorContentSchema])),
    isError: z.boolean().optional(),
  }),
});

export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
export type TextContent = z.infer<typeof TextContentSchema>;
export type ErrorContent = z.infer<typeof ErrorContentSchema>;
export type ToolCallResponse = z.infer<typeof ToolCallResponseSchema>;

// ---------------------------------------------------------------------------
// MCP Error codes
// ---------------------------------------------------------------------------

export const MCPErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Server-specific
  ToolNotFound: -32001,
  ToolExecutionError: -32002,
} as const;

export function makeErrorResponse(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? 0,
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
