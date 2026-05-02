/**
 * ACP Server Route — mounts POST /acp and GET /acp on the Hono app
 */

import type { Hono } from "hono";
import type { GlobalConfig } from "../core/types.js";
import { ACPServer, handleACPRequest, handleACPSSE } from "../acp/index.js";
import acpDefaultWorkflow from "../workflows/acp-default.json" with { type: "json" };

export function mountACPRoutes(app: Hono, globalConfig: GlobalConfig): void {
  const acpServer = new ACPServer(globalConfig, acpDefaultWorkflow as any);

  app.post("/acp", async (c) => {
    return handleACPRequest(c, acpServer);
  });

  app.get("/acp", async (c) => {
    return handleACPSSE(c, acpServer);
  });
}
