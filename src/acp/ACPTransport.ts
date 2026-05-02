/**
 * ACP Transport — HTTP POST + SSE transport for Agent Client Protocol
 *
 * POST /acp  → JSON-RPC requests
 * GET /acp?sessionId=xxx  → SSE stream of session/update notifications
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ACPServer } from "./ACPServer.js";
import type { SessionUpdate } from "./ACPTypes.js";
import { makeErrorResponse, ACPErrorCode } from "./ACPTypes.js";

export async function handleACPRequest(c: Context, server: ACPServer): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      makeErrorResponse(0, ACPErrorCode.ParseError, "Invalid JSON body"),
      400,
    );
  }

  // Batch request (array)
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return c.json(
        makeErrorResponse(0, ACPErrorCode.InvalidRequest, "Empty batch request"),
        400,
      );
    }
    const responses = await Promise.all(body.map((req) => server.dispatch(req)));
    const withId = responses.filter((r) => r.id !== undefined && r.id !== null);
    return c.json(withId.length === 1 ? withId[0] : withId);
  }

  const response = await server.dispatch(body);
  return c.json(response);
}

export function handleACPSSE(c: Context, server: ACPServer): Response {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ error: "Missing query param: sessionId" }, 400);
  }

  const sessions = server.getSessionManager();
  const session = sessions.getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    let eventId = 0;

    const handler = (update: SessionUpdate) => {
      if (stream.aborted) return;
      stream.writeSSE({
        id: String(eventId++),
        event: "session/update",
        data: JSON.stringify(update),
      }).catch(() => {});
    };

    sessions.subscribe(sessionId, handler);

    // Keep connection alive until session closes or client disconnects
    try {
      while (!stream.aborted && !session.closed) {
        await stream.sleep(1000);
      }
    } finally {
      sessions.unsubscribe(sessionId, handler);
    }
  });
}
