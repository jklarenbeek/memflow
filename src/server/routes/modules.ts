/**
 * Module Schema Introspection API — Phase 2
 *
 * Provides runtime inspection of module config schemas (Zod → JSON Schema)
 * and module metadata for the DAG Runner stage inspector.
 */

import { Hono } from "hono";
import { z, type ZodType } from "zod";
import type { GlobalConfig } from "../../core/types.js";
import { ModuleRegistry } from "../../core/ModuleRegistry.js";

// Use Zod 4's native JSON Schema conversion
function convertToJsonSchema(zodSchema: ZodType): unknown {
  return z.toJSONSchema(zodSchema);
}

export function createModulesRouter(_globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // GET /modules/:name/schema — Zod config → JSON Schema
  // -------------------------------------------------------------------------
  app.get("/:name/schema", async (c) => {
    try {
      const name = c.req.param("name");
      const registry = ModuleRegistry.getInstance();

      // Check if the module exists
      if (!registry.hasModule(name)) {
        return c.json({
          success: false,
          error: `Module '${name}' not found. Available: ${registry.listModules().slice(0, 10).join(", ")}...`,
        }, 404);
      }

      // Instantiate with empty config to introspect schema
      const mod = await registry.getModule(name, {}, `introspect_${name}`);
      const modAny = mod as unknown as Record<string, unknown>;

      // BaseModule may expose getConfigSchema() → Zod schema
      if (typeof modAny.getConfigSchema !== "function") {
        return c.json({
          success: true,
          name,
          configSchema: null,
          note: "This module does not define a config schema",
        });
      }

      const zodSchema = (modAny.getConfigSchema as () => ZodType)();

      // Convert Zod schema to JSON Schema
      const jsonSchema = await convertToJsonSchema(zodSchema);

      return c.json({
        success: true,
        name,
        configSchema: jsonSchema,
        supportsStreaming: typeof modAny.processStream === "function",
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    } finally {
      // Clean up introspection instance
      ModuleRegistry.getInstance().clearInstances();
    }
  });

  // -------------------------------------------------------------------------
  // GET /modules/:name/description — Module metadata
  // -------------------------------------------------------------------------
  app.get("/:name/description", async (c) => {
    try {
      const name = c.req.param("name");
      const registry = ModuleRegistry.getInstance();

      if (!registry.hasModule(name)) {
        return c.json({
          success: false,
          error: `Module '${name}' not found`,
        }, 404);
      }

      const mod = await registry.getModule(name, {}, `describe_${name}`);
      const modAny = mod as unknown as Record<string, unknown>;

      return c.json({
        success: true,
        name,
        version: modAny.version ?? "1.0",
        supportsStreaming: typeof modAny.processStream === "function",
        hasConfigSchema: typeof modAny.getConfigSchema === "function",
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    } finally {
      ModuleRegistry.getInstance().clearInstances();
    }
  });

  return app;
}
