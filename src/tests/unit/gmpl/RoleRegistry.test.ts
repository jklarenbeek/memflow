import { describe, it, expect, beforeEach } from "bun:test";
import { RoleRegistry } from "../../../gmpl/RoleRegistry.js";

describe("RoleRegistry", () => {
  beforeEach(() => {
    RoleRegistry.reset();
  });

  it("should auto-register 8 builtin roles", () => {
    const registry = RoleRegistry.getInstance();
    const roles = registry.list();
    expect(roles.length).toBe(8);
    expect(roles).toContain("domain_analyst");
    expect(roles).toContain("opposing_researcher");
    expect(roles).toContain("synthesizer");
    expect(roles).toContain("risk_assessor");
    expect(roles).toContain("decision_maker");
    expect(roles).toContain("critic");
    expect(roles).toContain("clarifier");
    expect(roles).toContain("outcome_evaluator");
  });

  it("should retrieve a role by ID", () => {
    const registry = RoleRegistry.getInstance();
    const analyst = registry.get("domain_analyst");
    expect(analyst).toBeDefined();
    expect(analyst!.persona).toBe("domain_analyst");
    expect(analyst!.requiredModules).toContain("EntityExtractor");
  });

  it("should return undefined for unknown role", () => {
    const registry = RoleRegistry.getInstance();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should extend a base role", () => {
    const registry = RoleRegistry.getInstance();
    const extended = registry.extend("trading_analyst", "domain_analyst", {
      description: "Trading-specific analyst",
      promptPack: "trading/fundamentals",
    });

    expect(extended.id).toBe("trading_analyst");
    expect(extended.base).toBe("domain_analyst");
    expect(extended.promptPack).toBe("trading/fundamentals");
    expect(extended.persona).toBe("domain_analyst"); // inherited
    expect(registry.has("trading_analyst")).toBe(true);
  });

  it("should throw when extending nonexistent base", () => {
    const registry = RoleRegistry.getInstance();
    expect(() =>
      registry.extend("bad", "nonexistent_base", {}),
    ).toThrow(/not found/);
  });

  it("should throw on duplicate registration", () => {
    const registry = RoleRegistry.getInstance();
    expect(() =>
      registry.register({
        id: "domain_analyst",
        description: "Duplicate",
        persona: "dup",
        inputSchema: {} as any,
        outputSchema: {} as any,
        requiredModules: [],
      }),
    ).toThrow(/already registered/);
  });

  it("should remove a role", () => {
    const registry = RoleRegistry.getInstance();
    registry.remove("risk_assessor");
    expect(registry.has("risk_assessor")).toBe(false);
    expect(registry.list().length).toBe(7);
  });
});
