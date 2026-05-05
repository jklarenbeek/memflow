/**
 * Graph Exploration API — Phase 2
 *
 * Endpoints for visual graph exploration: neighbor traversal,
 * subgraph extraction, community listing, timeline, and detailed stats.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "../../mcp/tools/_helpers.js";
import { normalizeNode, normalizeValue } from "./_helpers.js";

const SubgraphSchema = z.object({
  nodeIds: z.array(z.string()).min(1).max(100),
  maxDepth: z.number().min(1).max(5).default(2),
  filters: z.object({
    labels: z.array(z.string()).optional(),
    timeRange: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    }).optional(),
    community: z.string().optional(),
    solutionId: z.string().optional(),
  }).optional(),
});

export function createGraphExplorerRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // GET /graph/neighbors/:id — Expandable neighbor traversal
  // -------------------------------------------------------------------------
  app.get("/neighbors/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const depth = Math.min(Number(c.req.query("depth") ?? "1"), 3);
      const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);

      const result = await withMemgraph(globalConfig, async (client) => {
        // Get the central node
        const central = await client.query<{ n: Record<string, unknown>; labels: string[] }>(
          `MATCH (n {id: $id}) RETURN n, labels(n) AS labels LIMIT 1`,
          { id },
        );

        if (central.length === 0) return null;

        // Get neighbors up to depth
        const neighbors = await client.query<{
          neighbor: Record<string, unknown>;
          neighborLabels: string[];
          edgeType: string;
          direction: string;
        }>(
          `MATCH (n {id: $id})-[r]-(m)
           RETURN m AS neighbor,
                  labels(m) AS neighborLabels,
                  type(r) AS edgeType,
                  CASE WHEN startNode(r) = n THEN 'outgoing' ELSE 'incoming' END AS direction
           LIMIT toInteger($limit)`,
          { id, limit },
        );

        return {
          node: { ...normalizeNode(central[0].n), labels: central[0].labels },
          neighbors: neighbors.map((r) => ({
            node: { ...normalizeNode(r.neighbor), labels: r.neighborLabels },
            edge: r.edgeType,
            direction: r.direction,
          })),
        };
      });

      if (!result) return c.json({ success: false, error: "Node not found" }, 404);
      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // POST /graph/subgraph — Filtered subgraph for Orb rendering
  // -------------------------------------------------------------------------
  app.post("/subgraph", async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = SubgraphSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ success: false, error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
      }
      const { nodeIds, maxDepth, filters } = parsed.data;

      const result = await withMemgraph(globalConfig, async (client) => {
        // Build WHERE filters
        const whereFilters: string[] = [];
        const params: Record<string, unknown> = { nodeIds, maxDepth };

        if (filters?.labels?.length) {
          const labelChecks = filters.labels.map((l) => `m:${l}`).join(" OR ");
          whereFilters.push(`(${labelChecks})`);
        }
        if (filters?.solutionId) {
          whereFilters.push("m.solutionId = $solutionId");
          params.solutionId = filters.solutionId;
        }
        if (filters?.timeRange?.from) {
          whereFilters.push("m.createdAt >= $from");
          params.from = filters.timeRange.from;
        }
        if (filters?.timeRange?.to) {
          whereFilters.push("m.createdAt <= $to");
          params.to = filters.timeRange.to;
        }

        const whereClause = whereFilters.length > 0 ? `WHERE ${whereFilters.join(" AND ")}` : "";

        // Get subgraph: start from seed nodes, expand up to maxDepth
        const nodes = await client.query<{ n: Record<string, unknown>; nLabels: string[] }>(
          `MATCH (seed) WHERE seed.id IN $nodeIds
           MATCH path = (seed)-[*1..${maxDepth}]-(m)
           ${whereClause}
           WITH DISTINCT m AS n
           RETURN n, labels(n) AS nLabels
           LIMIT 500`,
          params,
        );

        // Also include the seed nodes themselves
        const seeds = await client.query<{ n: Record<string, unknown>; nLabels: string[] }>(
          `MATCH (n) WHERE n.id IN $nodeIds RETURN n, labels(n) AS nLabels`,
          { nodeIds },
        );

        // Get edges between all found nodes
        const allNodeIds = [...new Set([
          ...seeds.map((r) => (normalizeNode(r.n) as Record<string, unknown>).id as string),
          ...nodes.map((r) => (normalizeNode(r.n) as Record<string, unknown>).id as string),
        ])];

        const edges = await client.query<{
          srcId: string; tgtId: string; edgeType: string;
        }>(
          `MATCH (a)-[r]-(b)
           WHERE a.id IN $allNodeIds AND b.id IN $allNodeIds AND a.id < b.id
           RETURN a.id AS srcId, b.id AS tgtId, type(r) AS edgeType`,
          { allNodeIds },
        );

        return {
          nodes: [...seeds, ...nodes].map((r) => ({
            ...normalizeNode(r.n),
            labels: r.nLabels,
          })),
          edges: edges.map((r) => ({
            source: r.srcId,
            target: r.tgtId,
            type: r.edgeType,
          })),
        };
      });

      // Deduplicate nodes by ID
      const seenIds = new Set<string>();
      const uniqueNodes = result.nodes.filter((n) => {
        const nId = (n as Record<string, unknown>).id as string;
        if (seenIds.has(nId)) return false;
        seenIds.add(nId);
        return true;
      });

      return c.json({ success: true, nodes: uniqueNodes, edges: result.edges });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /graph/communities — Community nodes with summaries
  // -------------------------------------------------------------------------
  app.get("/communities", async (c) => {
    try {
      const solutionId = c.req.query("solutionId") ?? undefined;
      const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);

      const solutionFilter = solutionId ? "AND c.solutionId = $solutionId" : "";
      const params: Record<string, unknown> = { limit };
      if (solutionId) params.solutionId = solutionId;

      const result = await withMemgraph(globalConfig, async (client) => {
        return client.query<{
          c: Record<string, unknown>;
          memberCount: number;
          topEntities: string[];
        }>(
          `MATCH (c:Community)
           WHERE true ${solutionFilter}
           OPTIONAL MATCH (e:Entity {communityId: c.id})
           WITH c, count(DISTINCT e) AS memberCount, collect(DISTINCT e.name)[..5] AS topEntities
           RETURN c, memberCount, topEntities
           ORDER BY memberCount DESC
           LIMIT toInteger($limit)`,
          params,
        );
      });

      return c.json({
        success: true,
        communities: result.map((r) => ({
          ...normalizeNode(r.c),
          memberCount: Number(normalizeValue(r.memberCount)),
          topEntities: r.topEntities,
        })),
        count: result.length,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /graph/timeline — Memory/entity creation over time
  // -------------------------------------------------------------------------
  app.get("/timeline", async (c) => {
    try {
      const solutionId = c.req.query("solutionId") ?? undefined;
      const from = c.req.query("from") ?? undefined;
      const to = c.req.query("to") ?? undefined;
      const granularity = c.req.query("granularity") ?? "day"; // day | hour | week

      const filters: string[] = [];
      const params: Record<string, unknown> = {};
      if (solutionId) { filters.push("n.solutionId = $solutionId"); params.solutionId = solutionId; }
      if (from) { filters.push("n.createdAt >= $from"); params.from = from; }
      if (to) { filters.push("n.createdAt <= $to"); params.to = to; }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

      const result = await withMemgraph(globalConfig, async (client) => {
        return client.query<{
          label: string;
          date: string;
          count: number;
        }>(
          `MATCH (n)
           WHERE (n:MemoryUnit OR n:Entity OR n:Chunk)
           AND n.createdAt IS NOT NULL
           ${whereClause ? `AND ${filters.join(" AND ")}` : ""}
           WITH labels(n)[0] AS label,
                substring(n.createdAt, 0, 10) AS date,
                n
           RETURN label, date, count(*) AS count
           ORDER BY date ASC`,
          params,
        );
      });

      return c.json({
        success: true,
        timeline: result.map((r) => ({
          label: r.label,
          date: r.date,
          count: Number(normalizeValue(r.count)),
        })),
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /graph/stats — Detailed per-solution statistics
  // -------------------------------------------------------------------------
  app.get("/stats", async (c) => {
    try {
      const solutionId = c.req.query("solutionId") ?? undefined;

      const solutionFilter = solutionId ? "AND n.solutionId = $solutionId" : "";
      const params: Record<string, unknown> = {};
      if (solutionId) params.solutionId = solutionId;

      const result = await withMemgraph(globalConfig, async (client) => {
        const nodeCounts = await client.query<{ label: string; count: number }>(
          `MATCH (n)
           WHERE (n:MemoryUnit OR n:Entity OR n:Chunk OR n:Community OR n:Solution OR n:Skill)
           ${solutionFilter}
           WITH labels(n)[0] AS label
           RETURN label, count(*) AS count
           ORDER BY count DESC`,
          params,
        );

        const relCounts = await client.query<{ type: string; count: number }>(
          `MATCH (a)-[r]->(b)
           WHERE (a:MemoryUnit OR a:Entity OR a:Chunk)
           ${solutionFilter ? `AND a.solutionId = $solutionId` : ""}
           WITH type(r) AS type
           RETURN type, count(*) AS count
           ORDER BY count DESC`,
          params,
        );

        const entityTypes = await client.query<{ entityType: string; count: number }>(
          `MATCH (e:Entity)
           WHERE e.type IS NOT NULL ${solutionFilter ? "AND e.solutionId = $solutionId" : ""}
           RETURN e.type AS entityType, count(*) AS count
           ORDER BY count DESC`,
          params,
        );

        return {
          nodeCounts: nodeCounts.map((c) => ({ label: c.label, count: Number(normalizeValue(c.count)) })),
          relationCounts: relCounts.map((c) => ({ type: c.type, count: Number(normalizeValue(c.count)) })),
          entityTypes: entityTypes.map((c) => ({ type: c.entityType, count: Number(normalizeValue(c.count)) })),
        };
      });

      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
