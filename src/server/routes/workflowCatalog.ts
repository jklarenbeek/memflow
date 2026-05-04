/**
 * Workflow Catalog API
 *
 * Enumerates available workflow JSON files for the desktop sidebar.
 */

import { Hono } from "hono";
import { readdir, readFile } from "fs/promises";
import { join, basename, relative } from "path";
import type { GlobalConfig } from "../../core/types.js";

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
          filePath: relative(process.cwd(), fullPath).replace(/\\/g, "/"),
        });
      } catch {
        // Skip unparseable files
      }
    }
  } catch {
    // Directory doesn't exist — that's fine
  }
  return entries;
}

export function createWorkflowCatalogRouter(_globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // GET /workflows/catalog — Enumerate all workflows
  app.get("/catalog", async (c) => {
    try {
      const root = process.cwd();
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
  app.get("/catalog/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const root = process.cwd();
      const dirs = [
        join(root, "src/workflows/examples"),
        join(root, "src/workflows/sub"),
        join(root, "src/workflows/service"),
      ];

      for (const dir of dirs) {
        try {
          const filePath = join(dir, `${name}.json`);
          const content = await readFile(filePath, "utf-8");
          return c.json({ success: true, workflow: JSON.parse(content) });
        } catch {
          // Try next directory
        }
      }

      return c.json({ success: false, error: `Workflow '${name}' not found` }, 404);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
