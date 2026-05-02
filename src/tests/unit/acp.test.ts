import { describe, test, expect, mock } from "bun:test";
import { ACPServer } from "../../acp/ACPServer.js";
import { ACPErrorCode } from "../../acp/ACPTypes.js";
import { mountACPRoutes } from "../../server/acp.js";
import { Hono } from "hono";

const dummyWorkflow = {
  name: "test",
  version: "1.0",
  entry: "start",
  stages: [{ id: "start", module: "QueryTranslator", config: {} }],
} as any;

describe("ACPServer.dispatch", () => {
  test("initialize returns correct protocol version", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect((response.result as any)?.protocolVersion).toBe("2024-11-05");
    expect((response.result as any)?.serverInfo?.name).toBe("memflow-acp");
  });

  test("session/new creates a session", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {},
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);
    expect(typeof (response.result as any)?.sessionId).toBe("string");
  });

  test("session/list returns created sessions", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    await server.dispatch({ jsonrpc: "2.0", id: 1, method: "session/new" });

    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "session/list",
    });

    const result = response.result as any;
    expect(result.sessions).toBeArray();
    expect(result.sessions.length).toBeGreaterThan(0);
  });

  test("session/close closes a session", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    const newRes = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "session/new" });
    const sessionId = (newRes.result as any).sessionId;

    const closeRes = await server.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "session/close",
      params: { sessionId },
    });

    expect((closeRes.result as any)?.closed).toBe(true);
  });

  test("session/prompt returns error for missing sessionId", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "hello" }] },
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(ACPErrorCode.InvalidParams);
  });

  test("invalid method returns MethodNotFound", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    const response = await server.dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "invalid/method",
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(ACPErrorCode.MethodNotFound);
  });

  test("invalid JSON-RPC request returns ParseError", async () => {
    const server = new ACPServer({}, dummyWorkflow);
    const response = await server.dispatch({ invalid: true });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(ACPErrorCode.ParseError);
  });
});

describe("POST /acp", () => {
  test("returns initialize response", async () => {
    const app = new Hono();
    mountACPRoutes(app, {});

    const res = await app.request("/acp", {
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
    expect(body.result.serverInfo.name).toBe("memflow-acp");
  });

  test("session/new via HTTP", async () => {
    const app = new Hono();
    mountACPRoutes(app, {});

    const res = await app.request("/acp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.result.sessionId).toBe("string");
  });
});
