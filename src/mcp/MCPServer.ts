/**
 * MCP Server — JSON-RPC 2.0 dispatcher for Model Context Protocol
 *
 * Handles initialize, tools/list, and tools/call methods.
 * Tool handlers are registered at startup and executed with typed arguments.
 */

import {
  JSONRPCRequestSchema,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type ToolDefinition,
  InitializeResponseSchema,
  ToolsListResponseSchema,
  ToolCallResponseSchema,
  makeErrorResponse,
  makeSuccessResponse,
  MCPErrorCode,
  type TextContent,
  type ErrorContent,
} from "./MCPTypes.js";
import type { GlobalConfig } from "../core/types.js";

export type ToolHandler = (args: Record<string, unknown>, globalConfig: GlobalConfig) => Promise<unknown>;

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class MCPServer {
  private readonly tools = new Map<string, RegisteredTool>();
  private initialized = false;

  constructor(private readonly globalConfig: GlobalConfig) {}

  /** Register a tool with its definition and handler function. */
  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  /** Dispatch a JSON-RPC request to the appropriate handler. */
  async dispatch(request: unknown): Promise<JSONRPCResponse> {
    let parsed: JSONRPCRequest;
    try {
      parsed = JSONRPCRequestSchema.parse(request);
    } catch (err) {
      return makeErrorResponse(
        (request as any)?.id ?? 0,
        MCPErrorCode.ParseError,
        `Invalid JSON-RPC request: ${(err as Error).message}`,
      );
    }

    const { id = 0, method, params = {} } = parsed;

    try {
      switch (method) {
        case "initialize":
          return this.handleInitialize(id);

        case "tools/list":
          return this.handleToolsList(id);

        case "tools/call": {
          const name = (params as Record<string, unknown>).name as string;
          const args = ((params as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;
          return await this.handleToolCall(id, name, args);
        }

        default:
          return makeErrorResponse(
            id,
            MCPErrorCode.MethodNotFound,
            `Method not found: ${method}`,
          );
      }
    } catch (err) {
      return makeErrorResponse(
        id,
        MCPErrorCode.InternalError,
        (err as Error).message,
      );
    }
  }

  private handleInitialize(id: string | number): JSONRPCResponse {
    this.initialized = true;
    return makeSuccessResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "memflow-mcp", version: "0.5.0" },
    });
  }

  private handleToolsList(id: string | number): JSONRPCResponse {
    const tools = Array.from(this.tools.values()).map((t) => t.definition);
    return makeSuccessResponse(id, { tools });
  }

  private async handleToolCall(
    id: string | number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<JSONRPCResponse> {
    const tool = this.tools.get(name);
    if (!tool) {
      return makeErrorResponse(
        id,
        MCPErrorCode.ToolNotFound,
        `Tool not found: ${name}`,
      );
    }

    try {
      const result = await tool.handler(args, this.globalConfig);

      const textContent: TextContent = {
        type: "text",
        text: JSON.stringify(result, null, 2),
      };

      return makeSuccessResponse(id, {
        content: [textContent],
        isError: false,
      });
    } catch (err) {
      const errorContent: ErrorContent = {
        type: "error",
        code: "EXECUTION_ERROR",
        message: (err as Error).message,
      };

      return makeSuccessResponse(id, {
        content: [errorContent],
        isError: true,
      });
    }
  }
}
