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
import { handleRunPattern } from "../mcp/tools/runPattern.js";
import { handleResolveOutcome } from "../mcp/tools/resolveOutcome.js";

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

  // GMPL pattern tools

  mcpServer.registerTool(
    {
      name: "gmpl_run_pattern",
      description: "Execute a GMPL pattern (structured debate, parallel analysis, peer review, etc.) against a query. Returns the pattern's final answer and full state.",
      inputSchema: {
        type: "object",
        properties: {
          patternId: {
            type: "string",
            description: "Pattern ID from PatternRegistry (e.g. 'structured_debate', 'parallel_analysis', 'peer_review', 'red_team', 'delphi_panel', 'clarification_pipeline')",
          },
          query: { type: "string", description: "The query or topic for the pattern" },
          config: {
            type: "object",
            description: "Optional pattern-specific config overrides (roles, rounds, etc.)",
          },
          tenantId: { type: "string", description: "Optional tenant ID for domain isolation" },
        },
        required: ["patternId", "query"],
      },
    },
    (args: Record<string, unknown>) => handleRunPattern(args, globalConfig),
  );

  mcpServer.registerTool(
    {
      name: "gmpl_resolve_outcome",
      description: "Resolve a pending decision with a real-world outcome. Closes the feedback loop for GMPL pattern decisions, generating reflections and confidence adjustments.",
      inputSchema: {
        type: "object",
        properties: {
          pendingId: { type: "string", description: "ID of the pending decision to resolve" },
          outcome: {
            type: "string",
            enum: ["success", "failure", "partial"],
            description: "Outcome classification",
          },
          summary: { type: "string", description: "Human-readable outcome summary" },
          metrics: {
            type: "object",
            description: "Optional domain-specific metrics (e.g. { actualReturn: 0.05 })",
          },
          tenantId: { type: "string", description: "Optional tenant ID for domain adapter lookup" },
          evaluatorContext: {
            type: "object",
            description: "Optional context passed to the domain adapter's outcomeEvaluator",
          },
        },
        required: ["pendingId", "outcome", "summary"],
      },
    },
    (args: Record<string, unknown>) => handleResolveOutcome(args, globalConfig),
  );

  app.post("/mcp", async (c) => {
    return handleMCPRequest(c, mcpServer);
  });
}
