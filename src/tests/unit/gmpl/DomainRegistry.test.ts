import { describe, it, expect, beforeEach } from "bun:test";
import { DomainRegistry } from "../../../gmpl/DomainRegistry.js";
import type { DomainAdapter } from "../../../gmpl/types.js";
import { z } from "zod";

const mockAdapter: DomainAdapter = {
  id: "test_domain",
  version: "0.5.1",
  dataProviders: { getData: async () => ({}) },
  entitySchemas: [z.object({ name: z.string() })],
  outcomeEvaluator: async () => ({ raw: null, outcome: "success", summary: "ok" }),
  metricsCalculator: () => ({ accuracy: 0.9 }),
  promptPacks: { main: { path: "test/main", version: "1.0" } },
};

describe("DomainRegistry", () => {
  beforeEach(() => {
    DomainRegistry.reset();
  });

  it("should register and retrieve a domain adapter", () => {
    const registry = DomainRegistry.getInstance();
    registry.register(mockAdapter);
    expect(registry.has("test_domain")).toBe(true);
    expect(registry.get("test_domain")).toBeDefined();
    expect(registry.get("test_domain")!.version).toBe("0.5.1");
  });

  it("should list registered adapters", () => {
    const registry = DomainRegistry.getInstance();
    registry.register(mockAdapter);
    expect(registry.list()).toEqual(["test_domain"]);
  });

  it("should throw on duplicate registration", () => {
    const registry = DomainRegistry.getInstance();
    registry.register(mockAdapter);
    expect(() => registry.register(mockAdapter)).toThrow(/already registered/);
  });

  it("should throw on missing required fields", () => {
    const registry = DomainRegistry.getInstance();
    expect(() =>
      registry.register({ id: "", version: "1.0" } as any),
    ).toThrow();
    expect(() =>
      registry.register({ id: "x", version: "1.0", dataProviders: {} } as any),
    ).toThrow(/outcomeEvaluator/);
  });

  it("should remove an adapter", () => {
    const registry = DomainRegistry.getInstance();
    registry.register(mockAdapter);
    registry.remove("test_domain");
    expect(registry.has("test_domain")).toBe(false);
  });

  it("should return undefined for unknown adapter", () => {
    const registry = DomainRegistry.getInstance();
    expect(registry.get("nonexistent")).toBeUndefined();
  });
});
