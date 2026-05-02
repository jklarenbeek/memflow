/**
 * memflow_entity_get — knowledge graph entity lookup
 *
 * Searches across MemoryUnit, Chunk, and Community nodes for entities
 * matching the given name or returns a graph summary.
 */

import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "./_helpers.js";

export interface EntityGetArgs {
  entityName?: string;
  entityId?: string;
  tenantId?: string;
  limit?: number;
}

export async function handleEntityGet(args: Record<string, unknown>, globalConfig: GlobalConfig) {
  const entityName = args.entityName as string | undefined;
  const entityId = args.entityId as string | undefined;
  const tenantId = args.tenantId as string | undefined;
  const limit = (args.limit as number) ?? 20;

  const tenantFilter = tenantId ? " AND n.tenantId = $tenantId " : "";
  const params: Record<string, unknown> = { limit: Math.min(limit, 100) };
  if (tenantId) params.tenantId = tenantId;

  return withMemgraph(globalConfig, async (client) => {
    // If a specific entity ID is provided, look it up directly
    if (entityId) {
      const results = await client.query<{ n: Record<string, unknown>; relations: unknown[] }>(
        `MATCH (n {id: $id}) ${tenantFilter}
         OPTIONAL MATCH (n)-[r]->(t)
         RETURN n, collect({type: type(r), targetId: t.id, targetLabels: labels(t)}) as relations
         LIMIT 1`,
        { ...params, id: entityId },
      );
      const record = results[0];
      return {
        found: !!record,
        entity: record?.n ?? null,
        relations: record?.relations ?? [],
      };
    }

    // If entity name is provided, search across node types
    if (entityName) {
      const namePattern = `(?i).*${entityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*`;
      const results = await client.query<{ n: Record<string, unknown>; labels: string[]; relations: unknown[] }>(
        `MATCH (n)
         WHERE (n:MemoryUnit OR n:Chunk OR n:Community OR n:Entity)
         AND (n.name =~ $pattern OR n.content =~ $pattern OR n.text =~ $pattern OR n.summary =~ $pattern)
         ${tenantFilter}
         WITH n, labels(n) as lbls
         OPTIONAL MATCH (n)-[r]->(t)
         RETURN n, lbls as labels, collect({type: type(r), targetId: t.id, targetName: t.name, targetLabels: labels(t)}) as relations
         LIMIT $limit`,
        { ...params, pattern: namePattern },
      );

      return {
        found: results.length > 0,
        count: results.length,
        entities: results.map((r) => ({
          ...r.n,
          labels: r.labels,
          relations: r.relations,
        })),
      };
    }

    // No filter — return graph summary
    const counts = await client.query<{ label: string; count: number }>(
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
      summary: true,
      nodeCounts: counts.map((c) => ({ label: c.label, count: Number(c.count) })),
      relationCounts: relCounts.map((c) => ({ type: c.type, count: Number(c.count) })),
    };
  });
}
