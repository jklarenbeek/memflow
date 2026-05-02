/**
 * MCP Transport — Streamable HTTP transport for Model Context Protocol
 *
 * Handles POST requests with JSON-RPC 2.0 bodies and returns JSON-RPC responses.
 * Supports both single requests and batch requests (array of requests).
 */

import type { Context } from "hono";
import type { MCPServer } from "./MCPServer.js";
import { makeErrorResponse, MCPErrorCode } from "./MCPTypes.js";

export async function handleMCPRequest(c: Context, server: MCPServer): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      makeErrorResponse(undefined, MCPErrorCode.ParseError, "Invalid JSON body"),
      400,
    );
  }

  // Batch request (array)
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return c.json(
        makeErrorResponse(undefined, MCPErrorCode.InvalidRequest, "Empty batch request"),
        400,
      );
    }
    const responses = await Promise.all(body.map((req) => server.dispatch(req)));
    // Filter out notifications (no id) from responses
    const withId = responses.filter((r) => r.id !== undefined && r.id !== null);
    return c.json(withId.length === 1 ? withId[0] : withId);
  }

  // Single request
  const response = await server.dispatch(body);
  return c.json(response);
}
