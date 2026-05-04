/**
 * GMPL Pattern & Role Listing API — Phase 2
 *
 * Exposes the PatternRegistry and RoleRegistry as REST endpoints
 * so the desktop frontend can render pattern cards and role configurators.
 */

import { Hono } from "hono";
import type { GlobalConfig } from "../../core/types.js";
import { PatternRegistry } from "../../gmpl/PatternRegistry.js";
import { RoleRegistry } from "../../gmpl/RoleRegistry.js";

export function createGmplPatternsRouter(_globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // GET /gmpl/patterns — All registered GMPL patterns with config schemas
  // -------------------------------------------------------------------------
  app.get("/patterns", async (c) => {
    try {
      const registry = PatternRegistry.getInstance();
      const patternIds = registry.list();

      const patterns = patternIds.map((id) => {
        const pattern = registry.get(id);
        if (!pattern) {
          return { id, name: id, description: "Pattern metadata unavailable", requiredRoles: [] };
        }
        return {
          id: pattern.id,
          version: pattern.version,
          description: pattern.description ?? "",
          workflowRef: pattern.workflowRef,
          requiredRoles: pattern.requiredRoles ?? [],
          observabilityEvents: pattern.observabilityEvents ?? [],
          // Note: configSchema is a Zod object — we serialize the shape description
          hasConfigSchema: !!pattern.configSchema,
        };
      });

      return c.json({
        success: true,
        patterns,
        count: patterns.length,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // GET /gmpl/roles — All registered roles with persona and domain info
  // -------------------------------------------------------------------------
  app.get("/roles", async (c) => {
    try {
      const registry = RoleRegistry.getInstance();
      const roleIds = registry.list();

      const roles = roleIds.map((id) => {
        const role = registry.get(id);
        if (!role) {
          return { id, persona: "Role metadata unavailable", description: "" };
        }
        return {
          id: role.id,
          description: role.description ?? "",
          persona: role.persona ?? "",
          promptPack: role.promptPack ?? null,
          requiredModules: role.requiredModules ?? [],
          base: role.base ?? null,
        };
      });

      return c.json({
        success: true,
        roles,
        count: roles.length,
      });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
