/**
 * memflow_manage — CRUD operations on existing memories
 *
 * Direct Memgraph queries for get/update/delete of MemoryUnit nodes.
 */

import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "./_helpers.js";

export interface ManageArgs {
  operation: "get" | "update" | "delete";
  memoryId: string;
  content?: string;
  tenantId?: string;
}

export async function handleManage(args: Record<string, unknown>, globalConfig: GlobalConfig) {
  const operation = args.operation as string;
  const memoryId = args.memoryId as string;
  const content = args.content as string | undefined;
  const tenantId = args.tenantId as string | undefined;

  if (!memoryId || typeof memoryId !== "string") {
    throw new Error("Missing required argument: memoryId (string)");
  }

  const tenantFilter = tenantId ? " AND m.tenantId = $tenantId " : "";
  const params: Record<string, unknown> = { id: memoryId };
  if (tenantId) params.tenantId = tenantId;

  return withMemgraph(globalConfig, async (client) => {
    switch (operation) {
      case "get": {
        const results = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (m:MemoryUnit {id: $id}) ${tenantFilter} RETURN m LIMIT 1`,
          params,
        );
        const record = results[0]?.m;
        if (!record) return { found: false, memory: null };
        return { found: true, memory: record };
      }

      case "update": {
        if (!content || typeof content !== "string") {
          throw new Error("Missing required argument: content (string) for update operation");
        }
        const results = await client.query<{ m: Record<string, unknown> }>(
          `MATCH (m:MemoryUnit {id: $id}) ${tenantFilter}
           SET m.content = $content, m.updatedAt = $updatedAt
           RETURN m`,
          { ...params, content, updatedAt: new Date().toISOString() },
        );
        const record = results[0]?.m;
        return { updated: !!record, memory: record ?? null };
      }

      case "delete": {
        await client.query(
          `MATCH (m:MemoryUnit {id: $id}) ${tenantFilter} DETACH DELETE m`,
          params,
        );
        return { deleted: true, memoryId };
      }

      default:
        throw new Error(`Unknown operation: ${operation}. Must be one of: get, update, delete`);
    }
  });
}
