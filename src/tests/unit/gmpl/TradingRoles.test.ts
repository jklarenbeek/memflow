import { describe, it, expect, beforeEach } from "bun:test";
import { RoleRegistry } from "../../../gmpl/RoleRegistry.js";
import { registerTradingRoles } from "../../../domains/trading/roles.js";

describe("Trading Domain — Extended Roles", () => {
  beforeEach(() => {
    RoleRegistry.reset();
  });

  it("should register all 4 trading roles", () => {
    registerTradingRoles();
    const registry = RoleRegistry.getInstance();

    expect(registry.has("trading_fundamentals_analyst")).toBe(true);
    expect(registry.has("trading_technical_analyst")).toBe(true);
    expect(registry.has("trading_sentiment_analyst")).toBe(true);
    expect(registry.has("trading_risk_assessor")).toBe(true);
  });

  it("should bring total to 15 roles (11 core + 4 trading)", () => {
    registerTradingRoles();
    const registry = RoleRegistry.getInstance();
    expect(registry.list().length).toBe(15);
  });

  it("trading_fundamentals_analyst should extend fundamentals_analyst", () => {
    registerTradingRoles();
    const role = RoleRegistry.getInstance().get("trading_fundamentals_analyst");
    expect(role).toBeDefined();
    expect(role!.base).toBe("fundamentals_analyst");
    expect(role!.promptPack).toBe("trading/fundamentals");
    expect(role!.requiredModules).toContain("EntityExtractor");
    expect(role!.requiredModules).toContain("VectorSearch");
  });

  it("trading_technical_analyst should extend technical_analyst", () => {
    registerTradingRoles();
    const role = RoleRegistry.getInstance().get("trading_technical_analyst");
    expect(role).toBeDefined();
    expect(role!.base).toBe("technical_analyst");
    expect(role!.promptPack).toBe("trading/technical");
    expect(role!.requiredModules).toContain("EntityExtractor");
  });

  it("trading_sentiment_analyst should extend sentiment_analyst", () => {
    registerTradingRoles();
    const role = RoleRegistry.getInstance().get("trading_sentiment_analyst");
    expect(role).toBeDefined();
    expect(role!.base).toBe("sentiment_analyst");
    expect(role!.promptPack).toBe("trading/sentiment");
  });

  it("trading_risk_assessor should extend risk_assessor", () => {
    registerTradingRoles();
    const role = RoleRegistry.getInstance().get("trading_risk_assessor");
    expect(role).toBeDefined();
    expect(role!.base).toBe("risk_assessor");
    expect(role!.promptPack).toBe("trading/research");
    expect(role!.requiredModules).toContain("OutcomeMemory");
  });

  it("should inherit persona from base role", () => {
    registerTradingRoles();
    const base = RoleRegistry.getInstance().get("fundamentals_analyst");
    const extended = RoleRegistry.getInstance().get("trading_fundamentals_analyst");
    expect(extended!.persona).toBe(base!.persona);
  });

  it("should be idempotent — calling twice does not throw", () => {
    registerTradingRoles();
    expect(() => registerTradingRoles()).not.toThrow();
    expect(RoleRegistry.getInstance().list().length).toBe(15);
  });
});
