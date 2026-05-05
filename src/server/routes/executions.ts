/**
 * Execution History API — Phase 2
 *
 * Records and retrieves workflow execution history.
 * Stored as :WorkflowExecution nodes in Memgraph.
 */

import { Hono } from "hono";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "../../mcp/tools/_helpers.js";
import { normalizeNode, normalizeValue } from "./_helpers.js";

const CreateExecutionSchema = z.object({
  solutionId: z.string().min(1),
  conversationId: z.string().optional(),
  workflowName: z.string().min(1),
  status: z.enum(["complete", "error", "cancelled"]),
  stageCount: z.number().int().min(0),
  durationMs: z.number().min(0),
  finalAnswer: z.string().max(5000).optional(),
  stageTrace: z.array(z.object({
    stageId: z.string(),
    module: z.string(),
    durationMs: z.number(),
    status: z.string(),
  })).optional(),
  stateJson: z.string().optional(),
  tokenUsage: z.number().optional(),
  error: z.string().optional(),
});

export function createExecutionsRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // POST /executions — Record a completed workflow execution
  // -------------------------------------------------------------------------
  app.post("/", async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateExecutionSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
      }
      const body = parsed.data;
      const id = uuidv4();
      const now = new Date().toISOString();

      await withMemgraph(globalConfig, async (client) => {
        await client.query(
          `CREATE (e:WorkflowExecution {
            id: $id,
            solutionId: $solutionId,
            conversationId: $conversationId,
            workflowName: $workflowName,
            status: $status,
            stageCount: $stageCount,
            durationMs: $durationMs,
            finalAnswer: $finalAnswer,
            stageTraceJson: $stageTraceJson,
            stateJson: $stateJson,
            tokenUsage: $tokenUsage,
            error: $error,
            createdAt: $now
          })`,
          {
            id,
            solutionId: body.solutionId,
            conversationId: body.conversationId ?? null,
            workflowName: body.workflowName,
            status: body.status,
            stageCount: body.stageCount,
            durationMs: body.durationMs,
            finalAnswer: (body.finalAnswer ?? "").slice(0, 500),
            stageTraceJson: body.stageTrace ? JSON.stringify(body.stageTrace) : null,
            stateJson: body.stateJson ?? null,
            tokenUsage: body.tokenUsage ?? 0,
            error: body.error ?? null,
            now,
          },
        );

        // Link to conversation if provided
        if (body.conversationId) {
          await client.query(
            `MATCH (e:WorkflowExecution {id: $execId}), (c:Conversation {id: $convId})
             MERGE (e)-[:EXECUTED_IN]->(c)`,
            { execId: id, convId: body.conversationId },
          );
        }

        // Link to solution
        await client.query(
          `MATCH (e:WorkflowExecution {id: $execId}), (s:Solution {id: $solId})
           MERGE (e)-[:BELONGS_TO]->(s)`,
          { execId: id, solId: body.solutionId },
        );
      });

      return c.json({
        success: true,
        execution: {
          id,
          ...body,
          stageTrace: body.stageTrace ?? [],
          createdAt: now,
        },
      }, 201);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /executions — Paginated list by solutionId
  // -------------------------------------------------------------------------
  app.get("/", async (c) => {
    try {
      const solutionId = c.req.query("solutionId");
      const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
      const offset = Number(c.req.query("offset") ?? "0");
      const status = c.req.query("status");

      const filters: string[] = [];
      const params: Record<string, unknown> = { limit, offset };

      if (solutionId) {
        filters.push("e.solutionId = $solutionId");
        params.solutionId = solutionId;
      }
      if (status) {
        filters.push("e.status = $status");
        params.status = status;
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

      const result = await withMemgraph(globalConfig, async (client) => {
        return client.query<{ e: Record<string, unknown> }>(
          `MATCH (e:WorkflowExecution)
           ${whereClause}
           RETURN e
           ORDER BY e.createdAt DESC
           SKIP toInteger($offset) LIMIT toInteger($limit)`,
          params,
        );
      });

      return c.json({
        success: true,
        executions: result.map((r) => {
          const exec = normalizeNode(r.e);
          // Parse stageTrace JSON back to array if present
          if (exec.stageTraceJson && typeof exec.stageTraceJson === "string") {
            try { exec.stageTrace = JSON.parse(exec.stageTraceJson); } catch { /* ignore */ }
            delete exec.stageTraceJson;
          }
          return exec;
        }),
        count: result.length,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /executions/:id — Full WorkflowState for replay
  // -------------------------------------------------------------------------
  app.get("/:id", async (c) => {
    try {
      const id = c.req.param("id");

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ e: Record<string, unknown> }>(
          `MATCH (e:WorkflowExecution {id: $id}) RETURN e LIMIT 1`,
          { id },
        );
        return items[0]?.e ?? null;
      });

      if (!result) {
        return c.json({ success: false, error: "Execution not found" }, 404);
      }

      const exec = normalizeNode(result);
      // Parse JSON fields
      if (exec.stageTraceJson && typeof exec.stageTraceJson === "string") {
        try { exec.stageTrace = JSON.parse(exec.stageTraceJson); } catch { /* ignore */ }
        delete exec.stageTraceJson;
      }
      if (exec.stateJson && typeof exec.stateJson === "string") {
        try { exec.state = JSON.parse(exec.stateJson); } catch { /* ignore */ }
      }

      return c.json({ success: true, execution: exec });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
