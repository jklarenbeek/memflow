/**
 * Solution Management API
 *
 * Solutions are isolated workspaces. Each maps to `tenantId` for query scoping.
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "../../mcp/tools/_helpers.js";
import { normalizeNode, normalizeValue } from "./_helpers.js";
import { CreateSolutionSchema, UpdateSolutionSchema } from "@memflow/shared";

export function createSolutionsRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateSolutionSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map(i => i.message).join(", ") }, 400);
      }
      const body = parsed.data;
      const id = uuidv4();
      const now = new Date().toISOString();

      await withMemgraph(globalConfig, async (client) => {
        await client.query(
          `CREATE (s:Solution {
            id: $id, name: $name, description: $description, domain: $domain,
            llmProvider: $llmProvider, llmModel: $llmModel,
            createdAt: $now, updatedAt: $now, deletedAt: $deletedAt
          })`,
          { id, name: body.name, description: body.description ?? "", domain: body.domain ?? "custom",
            llmProvider: body.llmProvider ?? null, llmModel: body.llmModel ?? null, now, deletedAt: null },
        );
      });

      return c.json({ success: true, solution: { id, ...body, domain: body.domain ?? "custom", createdAt: now, updatedAt: now } }, 201);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/", async (c) => {
    try {
      const result = await withMemgraph(globalConfig, async (client) => {
        return client.query<{ s: Record<string, unknown>; entityCount: number; memoryCount: number; conversationCount: number }>(
          `MATCH (s:Solution) WHERE s.deletedAt IS NULL
           OPTIONAL MATCH (e:Entity {solutionId: s.id})
           WITH s, count(DISTINCT e) AS entityCount
           OPTIONAL MATCH (m:MemoryUnit {solutionId: s.id})
           WITH s, entityCount, count(DISTINCT m) AS memoryCount
           OPTIONAL MATCH (conv:Conversation)-[:BELONGS_TO]->(s)
           WHERE conv.deletedAt IS NULL
           RETURN s, entityCount, memoryCount, count(DISTINCT conv) AS conversationCount
           ORDER BY s.updatedAt DESC`,
        );
      });

      return c.json({
        success: true,
        solutions: result.map((r) => ({ ...normalizeNode(r.s), stats: { entityCount: Number(normalizeValue(r.entityCount)), memoryCount: Number(normalizeValue(r.memoryCount)), conversationCount: Number(normalizeValue(r.conversationCount)) } })),
        count: result.length,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ s: Record<string, unknown>; entityCount: number; memoryCount: number }>(
          `MATCH (s:Solution {id: $id}) WHERE s.deletedAt IS NULL
           OPTIONAL MATCH (e:Entity {solutionId: s.id})
           WITH s, count(DISTINCT e) AS entityCount
           OPTIONAL MATCH (m:MemoryUnit {solutionId: s.id})
           WITH s, entityCount, count(DISTINCT m) AS memoryCount
           RETURN s, entityCount, memoryCount`,
          { id },
        );
        return items[0] ?? null;
      });

      if (!result) return c.json({ success: false, error: "Solution not found" }, 404);
      return c.json({ success: true, solution: { ...normalizeNode(result.s), stats: { entityCount: Number(normalizeValue(result.entityCount)), memoryCount: Number(normalizeValue(result.memoryCount)) } } });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const raw = await c.req.json().catch(() => ({}));
      const parsed = UpdateSolutionSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map(i => i.message).join(", ") }, 400);
      }
      const body = parsed.data;
      const now = new Date().toISOString();
      const sets: string[] = ["s.updatedAt = $updatedAt"];
      const params: Record<string, unknown> = { id, updatedAt: now };

      for (const [key, val] of Object.entries(body)) {
        if (val !== undefined) { sets.push(`s.${key} = $${key}`); params[key] = val; }
      }

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ s: Record<string, unknown> }>(
          `MATCH (s:Solution {id: $id}) WHERE s.deletedAt IS NULL SET ${sets.join(", ")} RETURN s`, params);
        return items[0]?.s ?? null;
      });

      if (!result) return c.json({ success: false, error: "Solution not found" }, 404);
      return c.json({ success: true, solution: normalizeNode(result) });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const now = new Date().toISOString();
      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ s: Record<string, unknown> }>(
          `MATCH (s:Solution {id: $id}) WHERE s.deletedAt IS NULL
           SET s.deletedAt = $now, s.updatedAt = $now RETURN s`, { id, now });
        return items[0]?.s ?? null;
      });

      if (!result) return c.json({ success: false, error: "Solution not found" }, 404);
      return c.json({ success: true, deleted: true, solutionId: id });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
