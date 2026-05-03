import { describe, test, expect, mock } from "bun:test";
import { MCPServer } from "../../mcp/MCPServer.js";
import { MCPErrorCode } from "../../mcp/MCPTypes.js";
import { mountMCPRoutes } from "../../server/mcp.js";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// MCPServer dispatch tests
// ---------------------------------------------------------------------------

describe("MCPServer.dispatch", () => {
  test("initialize returns correct protocol version", async () => {
    const server = new MCPServer({});
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result?.protocolVersion).toBe("2024-11-05");
    expect((response.result as any)?.serverInfo?.name).toBe("memflow-mcp");
  });

  test("tools/list returns registered tools", async () => {
    const server = new MCPServer({});
    server.registerTool(
      { name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } },
      async () => ({ success: true }),
    );

    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);
    const tools = response.result?.tools as any[];
    expect(tools).toBeArrayOfSize(1);
    expect(tools[0].name).toBe("test_tool");
  });

  test("tools/call invokes handler and returns text content", async () => {
    const server = new MCPServer({});
    const handler = mock(async () => ({ result: "hello" }));

    server.registerTool(
      { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: {} } },
      handler,
    );

    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hi" } },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(3);
    const content = response.result?.content as any[];
    expect(content).toBeArrayOfSize(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("hello");
    expect(response.result?.isError).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("tools/call returns error for unknown tool", async () => {
    const server = new MCPServer({});
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(4);
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(MCPErrorCode.ToolNotFound);
  });

  test("invalid method returns MethodNotFound", async () => {
    const server = new MCPServer({});
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "invalid/method",
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(MCPErrorCode.MethodNotFound);
  });

  test("invalid JSON-RPC request returns ParseError", async () => {
    const server = new MCPServer({});
    const response = await server.dispatch({ invalid: true });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(MCPErrorCode.ParseError);
  });

  test("tool handler error returns error content", async () => {
    const server = new MCPServer({});
    server.registerTool(
      { name: "failing", description: "Fails", inputSchema: { type: "object", properties: {} } },
      async () => { throw new Error("intentional failure"); },
    );

    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "failing", arguments: {} },
    });

    expect(response.result?.isError).toBe(true);
    const content = response.result?.content as any[];
    expect(content[0].type).toBe("error");
    expect(content[0].message).toContain("intentional failure");
  });
});

// ---------------------------------------------------------------------------
// MCP route integration tests
// ---------------------------------------------------------------------------

describe("POST /mcp", () => {
  test("returns initialize response", async () => {
    const app = new Hono();
    mountMCPRoutes(app, {});

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.serverInfo.name).toBe("memflow-mcp");
  });

  test("tools/list returns all 7 memflow tools", async () => {
    const app = new Hono();
    mountMCPRoutes(app, {});

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.tools).toBeArrayOfSize(7);
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("memflow_write");
    expect(names).toContain("memflow_recall");
    expect(names).toContain("memflow_search");
    expect(names).toContain("memflow_manage");
    expect(names).toContain("memflow_entity_get");
    expect(names).toContain("gmpl_run_pattern");
    expect(names).toContain("gmpl_resolve_outcome");
  });

  test("batch request returns array of responses", async () => {
    const app = new Hono();
    mountMCPRoutes(app, {});

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toBeArrayOfSize(2);
  });

  test("empty batch returns error", async () => {
    const app = new Hono();
    mountMCPRoutes(app, {});

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });

    expect(res.status).toBe(400);
  });
});
