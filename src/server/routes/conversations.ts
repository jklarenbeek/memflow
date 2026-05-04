/**
 * Conversation + Message Persistence API
 *
 * Persists chat threads with full audit trails per message.
 */

import { Hono } from "hono";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "../../mcp/tools/_helpers.js";

const CreateConversationSchema = z.object({
  solutionId: z.string().uuid(),
  title: z.string().max(500).optional(),
  workflowName: z.string().max(200).optional(),
});

const CreateMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  workflowId: z.string().optional(),
  workflowName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateMessageSchema = z.object({
  content: z.string().optional(),
  stageTrace: z.array(z.object({
    stageId: z.string(),
    module: z.string(),
    durationMs: z.number(),
    status: z.string(),
  })).optional(),
  stageCount: z.number().optional(),
  durationMs: z.number().optional(),
  sources: z.array(z.string()).optional(),
  tokenUsage: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function createConversationsRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // POST /conversations — Create conversation
  app.post("/", async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateConversationSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map(i => i.message).join(", ") }, 400);
      }
      const body = parsed.data;
      const id = uuidv4();
      const now = new Date().toISOString();

      await withMemgraph(globalConfig, async (client) => {
        // Create conversation node and link to solution
        await client.query(
          `MATCH (s:Solution {id: $solutionId}) WHERE s.deletedAt IS NULL
           CREATE (c:Conversation {
             id: $id, solutionId: $solutionId, title: $title,
             workflowName: $workflowName, messageCount: 0,
             createdAt: $now, updatedAt: $now, deletedAt: $deletedAt
           })
           CREATE (c)-[:BELONGS_TO]->(s)`,
          { id, solutionId: body.solutionId, title: body.title ?? "New conversation",
            workflowName: body.workflowName ?? null, now, deletedAt: null },
        );
      });

      return c.json({ success: true, conversation: { id, ...body, title: body.title ?? "New conversation", messageCount: 0, createdAt: now } }, 201);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // GET /conversations?solutionId=X — List conversations
  app.get("/", async (c) => {
    try {
      const solutionId = c.req.query("solutionId");
      const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
      const offset = parseInt(c.req.query("offset") ?? "0", 10);

      const solutionFilter = solutionId ? "AND c.solutionId = $solutionId" : "";
      const params: Record<string, unknown> = { limit, offset };
      if (solutionId) params.solutionId = solutionId;

      const result = await withMemgraph(globalConfig, async (client) => {
        return client.query<{ c: Record<string, unknown>; lastMessage: string | null }>(
          `MATCH (c:Conversation) WHERE c.deletedAt IS NULL ${solutionFilter}
           OPTIONAL MATCH (m:Message)-[:IN_CONVERSATION]->(c)
           WITH c, m ORDER BY m.createdAt DESC
           WITH c, collect(m.content)[0] AS lastMessage
           RETURN c, lastMessage
           ORDER BY c.updatedAt DESC
           SKIP toInteger($offset) LIMIT toInteger($limit)`,
          params,
        );
      });

      return c.json({
        success: true,
        conversations: result.map((r) => ({ ...r.c, lastMessagePreview: r.lastMessage ? String(r.lastMessage).slice(0, 200) : null })),
        count: result.length,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // GET /conversations/:id — Get conversation with messages
  app.get("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const result = await withMemgraph(globalConfig, async (client) => {
        const convItems = await client.query<{ c: Record<string, unknown> }>(
          `MATCH (c:Conversation {id: $id}) WHERE c.deletedAt IS NULL RETURN c`, { id });
        if (!convItems[0]) return null;

        const messages = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (m:Message)-[:IN_CONVERSATION]->(c:Conversation {id: $id})
           RETURN m ORDER BY m.createdAt ASC`, { id });

        return { conversation: convItems[0].c, messages: messages.map(r => r.m) };
      });

      if (!result) return c.json({ success: false, error: "Conversation not found" }, 404);
      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // POST /conversations/:id/messages — Add message
  app.post("/:id/messages", async (c) => {
    try {
      const conversationId = c.req.param("id");
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateMessageSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map(i => i.message).join(", ") }, 400);
      }
      const body = parsed.data;
      const id = uuidv4();
      const now = new Date().toISOString();

      const message = await withMemgraph(globalConfig, async (client) => {
        // Create message + link to conversation + update message count
        const items = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (c:Conversation {id: $conversationId}) WHERE c.deletedAt IS NULL
           CREATE (m:Message {
             id: $id, conversationId: $conversationId, role: $role, content: $content,
             workflowId: $workflowId, workflowName: $workflowName,
             stageTrace: $stageTrace, stageCount: $stageCount,
             durationMs: $durationMs, sources: $sources, tokenUsage: $tokenUsage,
             metadata: $metadata, createdAt: $now
           })
           CREATE (m)-[:IN_CONVERSATION]->(c)
           SET c.messageCount = c.messageCount + 1, c.updatedAt = $now
           RETURN m`,
          { id, conversationId, role: body.role, content: body.content,
            workflowId: body.workflowId ?? null, workflowName: body.workflowName ?? null,
            stageTrace: null, stageCount: null, durationMs: null, sources: null,
            tokenUsage: null, metadata: body.metadata ? JSON.stringify(body.metadata) : null, now },
        );
        return items[0]?.m ?? null;
      });

      if (!message) return c.json({ success: false, error: "Conversation not found" }, 404);
      return c.json({ success: true, message }, 201);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // PATCH /conversations/:id/messages/:mid — Update message with audit trail
  app.patch("/:id/messages/:mid", async (c) => {
    try {
      const conversationId = c.req.param("id");
      const messageId = c.req.param("mid");
      const raw = await c.req.json().catch(() => ({}));
      const parsed = UpdateMessageSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map(i => i.message).join(", ") }, 400);
      }
      const body = parsed.data;
      const sets: string[] = [];
      const params: Record<string, unknown> = { messageId, conversationId };

      if (body.content !== undefined) { sets.push("m.content = $content"); params.content = body.content; }
      if (body.stageTrace !== undefined) { sets.push("m.stageTrace = $stageTrace"); params.stageTrace = JSON.stringify(body.stageTrace); }
      if (body.stageCount !== undefined) { sets.push("m.stageCount = $stageCount"); params.stageCount = body.stageCount; }
      if (body.durationMs !== undefined) { sets.push("m.durationMs = $durationMs"); params.durationMs = body.durationMs; }
      if (body.sources !== undefined) { sets.push("m.sources = $sources"); params.sources = JSON.stringify(body.sources); }
      if (body.tokenUsage !== undefined) { sets.push("m.tokenUsage = $tokenUsage"); params.tokenUsage = body.tokenUsage; }
      if (body.metadata !== undefined) { sets.push("m.metadata = $metadata"); params.metadata = JSON.stringify(body.metadata); }

      if (sets.length === 0) return c.json({ success: false, error: "No fields to update" }, 400);

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (m:Message {id: $messageId})-[:IN_CONVERSATION]->(c:Conversation {id: $conversationId})
           SET ${sets.join(", ")} RETURN m`, params);
        return items[0]?.m ?? null;
      });

      if (!result) return c.json({ success: false, error: "Message not found" }, 404);
      return c.json({ success: true, message: result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // POST /conversations/:id/fork — Fork from a checkpoint
  app.post("/:id/fork", async (c) => {
    try {
      const conversationId = c.req.param("id");
      const raw = await c.req.json().catch(() => ({}));
      const fromMessageId = (raw as Record<string, unknown>).fromMessageId as string | undefined;
      if (!fromMessageId) return c.json({ success: false, error: "Missing fromMessageId" }, 400);

      const newId = uuidv4();
      const now = new Date().toISOString();

      await withMemgraph(globalConfig, async (client) => {
        // Get original conversation's solution + copy messages up to fork point
        await client.query(
          `MATCH (c:Conversation {id: $conversationId})
           MATCH (c)-[:BELONGS_TO]->(s:Solution)
           CREATE (nc:Conversation {
             id: $newId, solutionId: c.solutionId, title: c.title + ' (fork)',
             workflowName: c.workflowName, messageCount: 0,
             createdAt: $now, updatedAt: $now, deletedAt: $deletedAt
           })
           CREATE (nc)-[:BELONGS_TO]->(s)
           WITH nc, c
           MATCH (m:Message)-[:IN_CONVERSATION]->(c)
           WHERE m.createdAt <= (
             MATCH (fm:Message {id: $fromMessageId}) RETURN fm.createdAt
           )
           CREATE (cm:Message)
           SET cm = m, cm.id = randomUUID(), cm.conversationId = $newId
           CREATE (cm)-[:IN_CONVERSATION]->(nc)
           SET nc.messageCount = nc.messageCount + 1`,
          { conversationId, newId, now, fromMessageId, deletedAt: null },
        );
      });

      return c.json({ success: true, forkedConversationId: newId }, 201);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
