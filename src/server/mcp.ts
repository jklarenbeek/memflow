/**
 * MCP Server Route — mounts POST /mcp on the Hono app
 */

import type { Hono } from "hono";
import type { GlobalConfig } from "../core/types.js";
import { MCPServer, handleMCPRequest } from "../mcp/index.js";
import { handleWrite } from "../mcp/tools/write.js";
import { handleRecall } from "../mcp/tools/recall.js";
import { handleSearch } from "../mcp/tools/search.js";
import { handleManage } from "../mcp/tools/manage.js";
import { handleEntityGet } from "../mcp/tools/entityGet.js";

export function mountMCPRoutes(app: Hono, globalConfig: GlobalConfig): void {
  const mcpServer = new MCPServer(globalConfig);

  // Register all MemFlow MCP tools
  mcpServer.registerTool(
    {
      name: "memflow_write",
      description: "Ingest memory content into MemFlow. Chunks, extracts facts, embeds, and persists to the knowledge graph.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The memory content to ingest" },
          tenantId: { type: "string", description: "Optional tenant ID for isolation" },
        },
        required: ["content"],
      },
    },
    handleWrite,
  );

  mcpServer.registerTool(
    {
      name: "memflow_recall",
      description: "Search memories and generate an LLM brief (answer). Uses hybrid retrieval + answer generation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query to recall context for" },
          tenantId: { type: "string", description: "Optional tenant ID for isolation" },
        },
        required: ["query"],
      },
    },
    handleRecall,
  );

  mcpServer.registerTool(
    {
      name: "memflow_search",
      description: "Raw hybrid search without LLM generation. Returns chunks, memories, and graph paths.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query to search for" },
          topK: { type: "number", description: "Maximum results to return (default 8)" },
          tenantId: { type: "string", description: "Optional tenant ID for isolation" },
        },
        required: ["query"],
      },
    },
    handleSearch,
  );

  mcpServer.registerTool(
    {
      name: "memflow_manage",
      description: "CRUD operations on existing memories. Operations: get, update, delete.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["get", "update", "delete"], description: "CRUD operation to perform" },
          memoryId: { type: "string", description: "ID of the memory to operate on" },
          content: { type: "string", description: "New content (required for update)" },
          tenantId: { type: "string", description: "Optional tenant ID for isolation" },
        },
        required: ["operation", "memoryId"],
      },
    },
    handleManage,
  );

  mcpServer.registerTool(
    {
      name: "memflow_entity_get",
      description: "Knowledge graph entity lookup. Search by name, ID, or get a full graph summary.",
      inputSchema: {
        type: "object",
        properties: {
          entityName: { type: "string", description: "Name pattern to search for" },
          entityId: { type: "string", description: "Exact entity ID to look up" },
          tenantId: { type: "string", description: "Optional tenant ID for isolation" },
          limit: { type: "number", description: "Max results when searching by name (default 20, max 100)" },
        },
      },
    },
    handleEntityGet,
  );

  app.post("/mcp", async (c) => {
    return handleMCPRequest(c, mcpServer);
  });
}
