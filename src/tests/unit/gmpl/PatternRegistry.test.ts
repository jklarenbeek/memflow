import { describe, it, expect, beforeEach } from "bun:test";
import { PatternRegistry } from "../../../gmpl/PatternRegistry.js";
import { z } from "zod";

describe("PatternRegistry", () => {
  beforeEach(() => {
    PatternRegistry.reset();
  });

  it("should auto-register builtin patterns on first access", () => {
    const registry = PatternRegistry.getInstance();
    const patterns = registry.list();
    expect(patterns).toContain("structured_debate");
    expect(patterns).toContain("clarification_pipeline");
    expect(patterns).toContain("parallel_analysis");
    expect(patterns).toContain("peer_review");
    expect(patterns).toContain("red_team");
    expect(patterns).toContain("delphi_panel");
    expect(patterns.length).toBe(6);
  });

  it("should retrieve a pattern by ID", () => {
    const registry = PatternRegistry.getInstance();
    const debate = registry.get("structured_debate");
    expect(debate).toBeDefined();
    expect(debate!.id).toBe("structured_debate");
    expect(debate!.version).toBe("0.5.1");
    expect(debate!.requiredRoles).toContain("opposing_researcher");
  });

  it("should return undefined for unknown pattern", () => {
    const registry = PatternRegistry.getInstance();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should register a custom pattern", () => {
    const registry = PatternRegistry.getInstance();
    registry.register({
      id: "custom_pattern",
      version: "0.5.1",
      description: "Test pattern",
      workflowRef: "test.json",
      configSchema: z.object({}),
      requiredRoles: [],
      inputContract: z.object({ query: z.string() }),
      outputContract: z.object({}),
      observabilityEvents: [],
    });

    expect(registry.has("custom_pattern")).toBe(true);
    expect(registry.list()).toContain("custom_pattern");
  });

  it("should throw on duplicate registration", () => {
    const registry = PatternRegistry.getInstance();
    expect(() =>
      registry.register({
        id: "structured_debate",
        version: "2.0.0",
        description: "Duplicate",
        workflowRef: "test.json",
        configSchema: z.object({}),
        requiredRoles: [],
        inputContract: z.object({}),
        outputContract: z.object({}),
        observabilityEvents: [],
      }),
    ).toThrow(/already registered/);
  });

  it("should validate schemas on registration", () => {
    const registry = PatternRegistry.getInstance();
    expect(() =>
      registry.register({
        id: "bad_pattern",
        version: "0.5.1",
        description: "Bad",
        workflowRef: "test.json",
        configSchema: "not a schema" as any,
        requiredRoles: [],
        inputContract: z.object({}),
        outputContract: z.object({}),
        observabilityEvents: [],
      }),
    ).toThrow(/invalid/);
  });

  it("should remove a pattern", () => {
    const registry = PatternRegistry.getInstance();
    expect(registry.has("structured_debate")).toBe(true);
    registry.remove("structured_debate");
    expect(registry.has("structured_debate")).toBe(false);
  });

  it("should return all patterns via getAll()", () => {
    const registry = PatternRegistry.getInstance();
    const all = registry.getAll();
    expect(all.length).toBe(6);
    expect(all.every((p) => p.id && p.version)).toBe(true);
  });

  it("should check has() correctly", () => {
    const registry = PatternRegistry.getInstance();
    expect(registry.has("structured_debate")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });
});
