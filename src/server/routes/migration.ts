/**
 * State Migration API
 *
 * Handles non-destructive migration of existing Memgraph data:
 * - Backfills `solutionId` on orphaned nodes
 * - Creates a default :Solution node
 * - Tracks migrations via :MigrationLog nodes
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import type { GlobalConfig } from "../../core/types.js";
import { withMemgraph } from "../../mcp/tools/_helpers.js";
import { normalizeNode } from "./_helpers.js";

const MIGRATION_V1_ID = "v1_backfill_solutionId";

export function createMigrationRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // POST /migrate — Run state migration
  app.post("/migrate", async (c) => {
    try {
      const result = await withMemgraph(globalConfig, async (client) => {
        // Check if migration already ran
        const existing = await client.query<{ ml: Record<string, unknown> }>(
          `MATCH (ml:MigrationLog {migrationId: $migrationId}) RETURN ml`,
          { migrationId: MIGRATION_V1_ID },
        );
        if (existing.length > 0) {
          return { alreadyRan: true, migrationLog: normalizeNode(existing[0].ml), migratedNodes: 0 };
        }

        // Detect orphaned nodes (no solutionId)
        const orphanCount = await client.query<{ total: number }>(
          `MATCH (n)
           WHERE (n:MemoryUnit OR n:Entity OR n:Chunk OR n:Skill OR n:PredictionHarness)
             AND n.solutionId IS NULL
           RETURN count(n) AS total`,
        );
        const count = Number(orphanCount[0]?.total ?? 0);

        if (count === 0) {
          // No orphans — still create migration log
          const logId = uuidv4();
          await client.query(
            `CREATE (:MigrationLog {
              id: $id, migrationId: $migrationId, migratedNodes: 0,
              message: 'No orphaned nodes found', createdAt: $now
            })`,
            { id: logId, migrationId: MIGRATION_V1_ID, now: new Date().toISOString() },
          );
          return { alreadyRan: false, migratedNodes: 0, message: "No orphaned nodes found" };
        }

        // Create default solution
        const defaultSolutionId = uuidv4();
        const now = new Date().toISOString();

        await client.query(
          `CREATE (:Solution {
            id: $id, name: 'Default', description: 'Auto-created solution for pre-existing data',
            domain: 'custom', llmProvider: $llmProvider, llmModel: $llmModel,
            createdAt: $now, updatedAt: $now, deletedAt: $deletedAt
          })`,
          { id: defaultSolutionId, llmProvider: null, llmModel: null, now, deletedAt: null },
        );

        // Backfill solutionId on all orphaned nodes
        const migrated = await client.query<{ migratedNodes: number }>(
          `MATCH (n)
           WHERE (n:MemoryUnit OR n:Entity OR n:Chunk OR n:Skill OR n:PredictionHarness)
             AND n.solutionId IS NULL
           SET n.solutionId = $defaultSolutionId
           RETURN count(n) AS migratedNodes`,
          { defaultSolutionId },
        );
        const migratedCount = Number(migrated[0]?.migratedNodes ?? 0);

        // Create migration log
        const logId = uuidv4();
        await client.query(
          `CREATE (:MigrationLog {
            id: $id, migrationId: $migrationId, migratedNodes: $migratedCount,
            defaultSolutionId: $defaultSolutionId,
            message: 'Backfilled solutionId on existing data', createdAt: $now
          })`,
          { id: logId, migrationId: MIGRATION_V1_ID, migratedCount, defaultSolutionId, now },
        );

        return { alreadyRan: false, migratedNodes: migratedCount, defaultSolutionId };
      });

      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // GET /migrate/status — Check migration status
  app.get("/migrate/status", async (c) => {
    try {
      const result = await withMemgraph(globalConfig, async (client) => {
        const logs = await client.query<{ ml: Record<string, unknown> }>(
          `MATCH (ml:MigrationLog) RETURN ml ORDER BY ml.createdAt DESC`,
        );
        const orphanCount = await client.query<{ total: number }>(
          `MATCH (n)
           WHERE (n:MemoryUnit OR n:Entity OR n:Chunk OR n:Skill OR n:PredictionHarness)
             AND n.solutionId IS NULL
           RETURN count(n) AS total`,
        );
        return {
          migrations: logs.map(r => normalizeNode(r.ml)),
          orphanedNodes: Number(orphanCount[0]?.total ?? 0),
        };
      });

      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
