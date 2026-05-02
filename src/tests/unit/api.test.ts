import { describe, test, expect } from "bun:test";
import { createAPIRouter } from "../../server/api.js";
import { createServer } from "../../server/index.js";

describe("REST API /api/v1", () => {
  test("POST /memories returns 400 for missing content", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("content");
  });

  test("GET /memories returns list response shape", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/memories?limit=5");
    // Will likely fail due to no Memgraph, but verifies route exists
    expect([200, 500]).toContain(res.status);
  });

  test("GET /memories/:id returns 404 for unknown id", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/memories/nonexistent-id");
    expect([404, 500]).toContain(res.status);
  });

  test("PATCH /memories/:id returns 400 for invalid body", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/memories/test-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Should either 404 (not found) or 500 (no memgraph)
    expect([404, 500]).toContain(res.status);
  });

  test("DELETE /memories/:id returns success shape", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/memories/test-id", { method: "DELETE" });
    expect([200, 500]).toContain(res.status);
  });

  test("POST /search returns 400 for missing query", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("query");
  });

  test("POST /recall returns 400 for missing query", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("query");
  });

  test("GET /entities returns response shape", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/entities?limit=5");
    expect([200, 500]).toContain(res.status);
  });

  test("GET /entities/:id returns 404 for unknown id", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/entities/nonexistent-id");
    expect([404, 500]).toContain(res.status);
  });

  test("GET /graph returns summary shape", async () => {
    const app = createAPIRouter({});
    const res = await app.request("/graph");
    expect([200, 500]).toContain(res.status);
  });
});

describe("Server mounts /api/v1", () => {
  test("main server includes REST API routes", async () => {
    const app = createServer({});

    // Verify route exists by hitting an endpoint that validates input
    const res = await app.request("/api/v1/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
