/**
 * Direct REST API — lightweight endpoints for memory CRUD and search
 *
 * These endpoints bypass workflow JSON for common operations, running
 * pre-built service workflows internally where appropriate.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import type { GlobalConfig } from "../core/types.js";
import { runServiceWorkflow, withMemgraph } from "../mcp/tools/_helpers.js";
import ingestWorkflow from "../workflows/service/ingest.json" with { type: "json" };
import recallWorkflow from "../workflows/service/recall.json" with { type: "json" };
import searchWorkflow from "../workflows/service/search.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Auth middleware hook — pluggable authentication/authorization
//
// Replace this no-op with JWT validation, API key checking, RBAC, etc.
// when project-wide auth is implemented. All endpoints below are protected
// by this middleware, so changes here apply globally.
//
// Example (API key):
//   const authMiddleware = async (c: Context, next: Next) => {
//     const apiKey = c.req.header("X-API-Key");
//     if (!apiKey || apiKey !== process.env.MEMFLOW_API_KEY) {
//       return c.json({ error: "Unauthorized" }, 401);
//     }
//     await next();
//   };
// ---------------------------------------------------------------------------

const authMiddleware = async (_c: Context, next: Next) => {
  // No-op: all requests are allowed. Replace with real auth when ready.
  await next();
};

export function createAPIRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // Apply auth middleware to all routes
  app.use("*", authMiddleware);

  // -----------------------------------------------------------------------
  // Memories
  // -----------------------------------------------------------------------

  app.post("/memories", async (c) => {
    try {
      const body = await c.req.json<{ content: string; tenantId?: string; metadata?: Record<string, unknown> }>();
      if (!body.content || typeof body.content !== "string") {
        return c.json({ error: "Missing required field: content (string)" }, 400);
      }

      const config = body.tenantId ? { ...globalConfig, tenantId: body.tenantId } : globalConfig;
      const data = await runServiceWorkflow(
        ingestWorkflow,
        {
          query: body.content,
          documents: [{ pageContent: body.content, metadata: { source: "rest-api", ...body.metadata } }],
        },
        config,
      );

      const memoryUnits = data.memoryUnits ?? [];
      return c.json({
        success: true,
        memoryIds: memoryUnits.map((u) => u.id),
        count: memoryUnits.length,
      }, 201);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/memories", async (c) => {
    try {
      const tenantId = c.req.query("tenantId") ?? undefined;
      const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
      const offset = Number(c.req.query("offset") ?? "0");
      const search = c.req.query("search") ?? undefined;

      const tenantFilter = tenantId ? " AND m.tenantId = $tenantId " : "";
      const searchFilter = search ? " AND toLower(m.content) CONTAINS toLower($search) " : "";
      const params: Record<string, unknown> = { limit, offset };
      if (tenantId) params.tenantId = tenantId;
      if (search) params.search = search;

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (m:MemoryUnit)
           WHERE true ${tenantFilter} ${searchFilter}
           RETURN m
           ORDER BY m.timestamp DESC
           SKIP $offset LIMIT $limit`,
          params,
        );
        const countResult = await client.query<{ total: number }>(
          `MATCH (m:MemoryUnit)
           WHERE true ${tenantFilter} ${searchFilter}
           RETURN count(*) as total`,
          params,
        );
        return {
          memories: items.map((r) => r.m),
          total: Number(countResult[0]?.total ?? 0),
        };
      });

      return c.json({
        success: true,
        memories: result.memories,
        pagination: { limit, offset, total: result.total },
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/memories/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const tenantId = c.req.query("tenantId") ?? undefined;

      const tenantFilter = tenantId ? " AND m.tenantId = $tenantId " : "";
      const params: Record<string, unknown> = { id };
      if (tenantId) params.tenantId = tenantId;

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ m: Record<string, unknown>; relations: unknown[] }>(
          `MATCH (m:MemoryUnit {id: $id}) ${tenantFilter}
           OPTIONAL MATCH (m)-[r]->(t)
           RETURN m, collect({type: type(r), targetId: t.id, targetName: t.name}) as relations
           LIMIT 1`,
          params,
        );
        return items[0] ?? null;
      });

      if (!result) {
        return c.json({ success: false, error: "Memory not found" }, 404);
      }

      return c.json({ success: true, memory: result.m, relations: result.relations });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.patch("/memories/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json<{ content?: string; metadata?: Record<string, unknown>; tenantId?: string }>();
      const tenantId = body.tenantId ?? undefined;

      const tenantFilter = tenantId ? " AND m.tenantId = $tenantId " : "";
      const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
      if (tenantId) params.tenantId = tenantId;

      const setClauses: string[] = ["m.updatedAt = $updatedAt"];
      if (body.content) {
        setClauses.push("m.content = $content");
        params.content = body.content;
      }
      if (body.metadata) {
        setClauses.push("m.metadata = $metadata");
        params.metadata = body.metadata;
      }

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (m:MemoryUnit {id: $id}) ${tenantFilter}
           SET ${setClauses.join(", ")}
           RETURN m`,
          params,
        );
        return items[0]?.m ?? null;
      });

      if (!result) {
        return c.json({ success: false, error: "Memory not found" }, 404);
      }

      return c.json({ success: true, memory: result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.delete("/memories/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const tenantId = c.req.query("tenantId") ?? undefined;

      const tenantFilter = tenantId ? " AND m.tenantId = $tenantId " : "";
      const params: Record<string, unknown> = { id, deletedAt: new Date().toISOString() };
      if (tenantId) params.tenantId = tenantId;

      await withMemgraph(globalConfig, async (client) => {
        await client.query(
          `MATCH (m:MemoryUnit {id: $id}) ${tenantFilter}
           SET m.deletedAt = $deletedAt`,
          params,
        );
      });

      return c.json({ success: true, deleted: true, memoryId: id });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // Search & Recall
  // -----------------------------------------------------------------------

  app.post("/search", async (c) => {
    try {
      const body = await c.req.json<{ query: string; tenantId?: string }>();
      if (!body.query || typeof body.query !== "string") {
        return c.json({ error: "Missing required field: query (string)" }, 400);
      }

      const config = body.tenantId ? { ...globalConfig, tenantId: body.tenantId } : globalConfig;
      const data = await runServiceWorkflow(searchWorkflow, { query: body.query }, config);

      const result = data.retrievalResult;
      return c.json({
        success: true,
        chunks: result?.chunks?.map((ch) => ({ content: ch.pageContent, metadata: ch.metadata })) ?? [],
        memories: result?.memories?.map((m) => ({ id: m.id, content: m.content, type: m.type })) ?? [],
        score: result?.score ?? 0,
        sources: result?.sources ?? [],
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.post("/recall", async (c) => {
    try {
      const body = await c.req.json<{ query: string; tenantId?: string }>();
      if (!body.query || typeof body.query !== "string") {
        return c.json({ error: "Missing required field: query (string)" }, 400);
      }

      const config = body.tenantId ? { ...globalConfig, tenantId: body.tenantId } : globalConfig;
      const data = await runServiceWorkflow(recallWorkflow, { query: body.query }, config);

      return c.json({
        success: true,
        answer: data.finalAnswer ?? "No answer generated.",
        sources: data.sources ?? [],
        confidence: data.confidence ?? 0,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // Entities & Graph
  // -----------------------------------------------------------------------

  app.get("/entities", async (c) => {
    try {
      const tenantId = c.req.query("tenantId") ?? undefined;
      const limit = Math.min(Number(c.req.query("limit") ?? "20"), 100);
      const search = c.req.query("search") ?? undefined;

      const tenantFilter = tenantId ? " AND n.tenantId = $tenantId " : "";
      const searchFilter = search
        ? " AND (n.name =~ $pattern OR n.content =~ $pattern OR n.text =~ $pattern) "
        : "";
      const params: Record<string, unknown> = { limit };
      if (tenantId) params.tenantId = tenantId;
      if (search) params.pattern = `(?i).*${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*`;

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ n: Record<string, unknown>; labels: string[] }>(
          `MATCH (n)
           WHERE (n:MemoryUnit OR n:Chunk OR n:Community OR n:Entity)
           ${tenantFilter} ${searchFilter}
           RETURN n, labels(n) as labels
           LIMIT $limit`,
          params,
        );
        return items.map((r) => ({ ...r.n, labels: r.labels }));
      });

      return c.json({ success: true, entities: result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/entities/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const tenantId = c.req.query("tenantId") ?? undefined;

      const tenantFilter = tenantId ? " AND n.tenantId = $tenantId " : "";
      const params: Record<string, unknown> = { id };
      if (tenantId) params.tenantId = tenantId;

      const result = await withMemgraph(globalConfig, async (client) => {
        const items = await client.query<{ n: Record<string, unknown>; relations: unknown[] }>(
          `MATCH (n {id: $id}) ${tenantFilter}
           OPTIONAL MATCH (n)-[r]->(t)
           RETURN n, collect({type: type(r), targetId: t.id, targetName: t.name, targetLabels: labels(t)}) as relations
           LIMIT 1`,
          params,
        );
        return items[0] ?? null;
      });

      if (!result) {
        return c.json({ success: false, error: "Entity not found" }, 404);
      }

      return c.json({ success: true, entity: result.n, relations: result.relations });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/graph", async (c) => {
    try {
      const result = await withMemgraph(globalConfig, async (client) => {
        const nodeCounts = await client.query<{ label: string; count: number }>(
          `MATCH (n)
           WITH labels(n)[0] as label
           RETURN label, count(*) as count
           ORDER BY count DESC`,
        );
        const relCounts = await client.query<{ type: string; count: number }>(
          `MATCH ()-[r]->()
           WITH type(r) as type
           RETURN type, count(*) as count
           ORDER BY count DESC`,
        );
        return {
          nodeCounts: nodeCounts.map((c) => ({ label: c.label, count: Number(c.count) })),
          relationCounts: relCounts.map((c) => ({ type: c.type, count: Number(c.count) })),
        };
      });

      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // Dataset Export (§7.1 — hardened with Zod + concurrency gate)
  // -----------------------------------------------------------------------

  const ExportRequestSchema = z.object({
    format: z.enum(["sft", "dpo", "both"]).default("both"),
    domain: z.string().optional(),
    maxSamples: z.number().min(1).max(100000).default(10000),
    minConfidence: z.number().min(0).max(1).default(0.6),
    deduplicationThreshold: z.number().min(0).max(1).default(0.92),
    requireRetrospectiveValidation: z.boolean().default(true),
  });

  let datasetExportInProgress = false;

  app.post("/datasets/export", async (c) => {
    // Concurrency gate: only one export at a time to prevent event-loop starvation
    if (datasetExportInProgress) {
      return c.json(
        { success: false, error: "An export is already in progress. Please wait and retry." },
        429,
      );
    }

    try {
      const rawBody = await c.req.json().catch(() => ({}));

      // Zod validation
      const parseResult = ExportRequestSchema.safeParse(rawBody);
      if (!parseResult.success) {
        return c.json(
          { success: false, error: `Validation failed: ${parseResult.error.issues.map(i => i.message).join(", ")}` },
          400,
        );
      }
      const body = parseResult.data;

      datasetExportInProgress = true;

      const exportWorkflow = {
        name: "slm-dataset-export",
        version: "1.0",
        entry: "export",
        stages: [{
          id: "export",
          module: "SLMDatasetExporter",
          config: {
            format: body.format,
            domainFilter: body.domain,
            maxSamples: body.maxSamples,
            trigger: { type: "on_demand" },
            quality: {
              minConfidence: body.minConfidence,
              deduplicationThreshold: body.deduplicationThreshold,
              requireRetrospectiveValidation: body.requireRetrospectiveValidation,
            },
          },
          next: null,
        }],
      };

      const data = await runServiceWorkflow(exportWorkflow, { query: "export" }, globalConfig);

      return c.json({
        success: true,
        path: data.datasetExportPath,
        manifest: data.datasetManifest ?? {
          exportedAt: new Date().toISOString(),
          sftCount: 0,
          dpoCount: 0,
          sources: {},
        },
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    } finally {
      datasetExportInProgress = false;
    }
  });

  // -----------------------------------------------------------------------
  // Skills (§7.2)
  // -----------------------------------------------------------------------

  app.get("/skills", async (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);

      const skills = await withMemgraph(globalConfig, async (client) => {
        return client.query<{
          id: string; name: string; description: string;
          applicableWhen: string; version: number; createdAt: string;
        }>(`
          MATCH (s:Skill)
          RETURN s.id AS id, s.name AS name, s.description AS description,
                 s.applicableWhen AS applicableWhen, s.version AS version,
                 s.createdAt AS createdAt
          ORDER BY s.createdAt DESC
          LIMIT $limit
        `, { limit });
      });

      return c.json({ success: true, skills, count: skills.length });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/skills/gaps", async (c) => {
    try {
      // Return latest skill basis info from ModuleState
      const result = await withMemgraph(globalConfig, async (client) => {
        const states = await client.query<{ data: string }>(`
          MATCH (ms:ModuleState)
          WHERE ms.moduleKey STARTS WITH 'SkillGapAnalyzer'
          RETURN ms.data AS data
          ORDER BY ms.updatedAt DESC
          LIMIT 1
        `);
        return states[0]?.data ? JSON.parse(states[0].data) : { skillGaps: [] };
      });

      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.post("/skills/distill", async (c) => {
    try {
      const body = await c.req.json<{
        k?: number;
        maxSkillsPerCluster?: number;
        persistToGraph?: boolean;
      }>().catch(() => ({}));

      const distillWorkflow = {
        name: "trace2skill-distill",
        version: "1.0",
        entry: "distill",
        stages: [{
          id: "distill",
          module: "Trace2Skill",
          config: {
            k: body.k ?? 5,
            maxSkillsPerCluster: body.maxSkillsPerCluster ?? 3,
            persistToGraph: body.persistToGraph ?? true,
          },
          next: null,
        }],
      };

      const data = await runServiceWorkflow(distillWorkflow, { query: "distill" }, globalConfig);

      return c.json({
        success: true,
        skillCount: data.distilledSkills?.length ?? 0,
        skills: data.distilledSkills?.map((s) => ({ id: s.id, name: s.name, description: s.description })) ?? [],
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // Harness Evolution (§7.2)
  // -----------------------------------------------------------------------

  app.post("/harness/evolve", async (c) => {
    try {
      const body = await c.req.json<{ query: string }>().catch(() => ({ query: "" }));
      if (!body.query || typeof body.query !== "string") {
        return c.json({ success: false, error: "Missing required field: query (string)" }, 400);
      }

      const evolveWorkflow = {
        name: "harness-evolve",
        version: "1.0",
        entry: "evolve",
        stages: [{
          id: "evolve",
          module: "HarnessEvolver",
          config: {},
          next: null,
        }],
      };

      const data = await runServiceWorkflow(evolveWorkflow, { query: body.query }, globalConfig);

      return c.json({
        success: true,
        harness: data.predictionHarness,
        feedback: data.internalFeedback,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // Workflow Compilation (§7.2)
  // -----------------------------------------------------------------------

  app.post("/workflows/compile", async (c) => {
    try {
      const body = await c.req.json<{ intent: string }>().catch(() => ({ intent: "" }));
      if (!body.intent || typeof body.intent !== "string") {
        return c.json({ success: false, error: "Missing required field: intent (string)" }, 400);
      }

      const compileWorkflow = {
        name: "intent-compile",
        version: "1.0",
        entry: "compile",
        stages: [{
          id: "compile",
          module: "IntentCompiler",
          config: {},
          next: null,
        }],
      };

      const data = await runServiceWorkflow(compileWorkflow, { query: body.intent }, globalConfig);

      return c.json({
        success: true,
        compiled: data.compiledWorkflow != null,
        workflow: data.compiledWorkflow,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
