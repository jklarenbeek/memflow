/**
 * Workflow Catalog API
 *
 * Enumerates available workflow JSON files for the desktop sidebar.
 */

import { Hono } from "hono";
import { readdir, readFile } from "fs/promises";
import { join, basename, relative, resolve } from "path";
import type { GlobalConfig } from "../../core/types.js";

/** Resolve project root relative to this file (src/server/routes → project root) */
const PROJECT_ROOT = resolve(import.meta.dir ?? process.cwd(), "../../..");

interface WorkflowCatalogEntry {
  name: string;
  version: string;
  description: string;
  category: "example" | "sub" | "service";
  entry: string;
  stageCount: number;
  stages: string[];
  filePath: string;
}

async function scanWorkflowDir(dirPath: string, category: WorkflowCatalogEntry["category"]): Promise<WorkflowCatalogEntry[]> {
  const entries: WorkflowCatalogEntry[] = [];
  try {
    const files = await readdir(dirPath, { recursive: false });
    for (const file of files) {
      if (typeof file !== "string" || !file.endsWith(".json")) continue;
      try {
        const fullPath = join(dirPath, file);
        const content = await readFile(fullPath, "utf-8");
        const wf = JSON.parse(content);
        entries.push({
          name: wf.name ?? basename(file, ".json"),
          version: wf.version ?? "1.0",
          description: wf.description ?? "",
          category,
          entry: wf.entry ?? "",
          stageCount: Array.isArray(wf.stages) ? wf.stages.length : 0,
          stages: Array.isArray(wf.stages) ? wf.stages.map((s: { id?: string; module?: string }) => s.id ?? s.module ?? "unknown") : [],
          filePath: relative(PROJECT_ROOT, fullPath).replace(/\\/g, "/"),
        });
      } catch (e) {
        console.warn(`[workflowCatalog] failed to parse ${file}: ${e}`);
      }
    }
  } catch (e) {
    // Directory doesn't exist — log it
    console.debug(`[workflowCatalog] directory not found: ${dirPath}: ${e}`);
  }
  return entries;
}

export function createWorkflowCatalogRouter(_globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // GET /workflows/catalog — Enumerate all workflows
  app.get("/catalog", async (c) => {
    try {
      const root = PROJECT_ROOT;
      const [examples, subs, services] = await Promise.all([
        scanWorkflowDir(join(root, "src/workflows/examples"), "example"),
        scanWorkflowDir(join(root, "src/workflows/sub"), "sub"),
        scanWorkflowDir(join(root, "src/workflows/service"), "service"),
      ]);

      const catalog = [...examples, ...subs, ...services];
      return c.json({ success: true, workflows: catalog, count: catalog.length });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // GET /workflows/catalog/:name — Get full workflow JSON by name
  // Searches by the internal `name` field inside each JSON file, not by filename.
  app.get("/catalog/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const root = PROJECT_ROOT;
      const dirs = [
        join(root, "src/workflows/examples"),
        join(root, "src/workflows/sub"),
        join(root, "src/workflows/service"),
      ];

      for (const dir of dirs) {
        let files: string[];
        try {
          files = (await readdir(dir)).filter((f) => typeof f === "string" && f.endsWith(".json"));
        } catch {
          continue; // directory doesn't exist
        }

        for (const file of files) {
          try {
            const fullPath = join(dir, file);
            const content = await readFile(fullPath, "utf-8");
            const wf = JSON.parse(content);
            const wfName = wf.name ?? basename(file, ".json");
            if (wfName === name) {
              return c.json({ success: true, workflow: wf });
            }
          } catch { /* skip unparseable files */ }
        }
      }

      return c.json({ success: false, error: `Workflow '${name}' not found` }, 404);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
