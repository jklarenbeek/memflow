import { describe, it, expect, beforeEach } from "bun:test";
import { DomainRegistry } from "../../../gmpl/DomainRegistry.js";
import { tradingAdapter } from "../../../domains/trading/adapter.js";
import {
  TickerSchema,
  EarningsReportSchema,
  TechnicalIndicatorSchema,
  MarketDataSchema,
  SentimentDataSchema,
} from "../../../domains/trading/schemas.js";
import type { PendingDecision, Decision } from "../../../gmpl/types.js";

describe("Trading Domain Adapter", () => {
  beforeEach(() => {
    DomainRegistry.reset();
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  it("should register in DomainRegistry", () => {
    const registry = DomainRegistry.getInstance();
    registry.register(tradingAdapter);

    expect(registry.has("trading")).toBe(true);
    expect(registry.get("trading")?.version).toBe("0.5.1");
  });

  it("should reject duplicate registration", () => {
    const registry = DomainRegistry.getInstance();
    registry.register(tradingAdapter);

    expect(() => registry.register(tradingAdapter)).toThrow(/already registered/);
  });

  // -----------------------------------------------------------------------
  // Data providers
  // -----------------------------------------------------------------------

  it("getMarketData should return valid MarketData", async () => {
    const result = await tradingAdapter.dataProviders.getMarketData("AAPL", "2024-01-01", "2024-03-29");
    expect(Array.isArray(result)).toBe(true);
    const parsed = MarketDataSchema.safeParse((result as unknown[])[0]);
    expect(parsed.success).toBe(true);
  });

  it("getEarningsReport should return valid EarningsReport", async () => {
    const result = await tradingAdapter.dataProviders.getEarningsReport("AAPL", "Q4", 2024);
    const parsed = EarningsReportSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("getSentiment should return valid SentimentData", async () => {
    const result = await tradingAdapter.dataProviders.getSentiment("AAPL", "2024-01-15");
    const parsed = SentimentDataSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("getTechnicalIndicators should return valid TechnicalIndicator", async () => {
    const result = await tradingAdapter.dataProviders.getTechnicalIndicators("AAPL", "2024-01-15");
    const parsed = TechnicalIndicatorSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Outcome evaluator
  // -----------------------------------------------------------------------

  it("should evaluate success when direction correct and within tolerance", async () => {
    const pending: PendingDecision = {
      id: "test-1", patternId: "structured_debate",
      content: "Buy AAPL", entityIds: [], timestamp: new Date().toISOString(),
    };
    const result = await tradingAdapter.outcomeEvaluator(pending, {
      predictedReturn: 0.10,
      actualReturn: 0.12,
    });
    expect(result.outcome).toBe("success");
    expect(result.summary).toContain("Direction correct");
  });

  it("should evaluate partial when direction correct but magnitude off", async () => {
    const pending: PendingDecision = {
      id: "test-2", patternId: "structured_debate",
      content: "Buy AAPL", entityIds: [], timestamp: new Date().toISOString(),
    };
    const result = await tradingAdapter.outcomeEvaluator(pending, {
      predictedReturn: 0.10,
      actualReturn: 0.25,
    });
    expect(result.outcome).toBe("partial");
    expect(result.summary).toContain("magnitude off");
  });

  it("should evaluate failure when direction is wrong", async () => {
    const pending: PendingDecision = {
      id: "test-3", patternId: "structured_debate",
      content: "Buy AAPL", entityIds: [], timestamp: new Date().toISOString(),
    };
    const result = await tradingAdapter.outcomeEvaluator(pending, {
      predictedReturn: 0.10,
      actualReturn: -0.05,
    });
    expect(result.outcome).toBe("failure");
    expect(result.summary).toContain("Wrong direction");
  });

  // -----------------------------------------------------------------------
  // Metrics calculator
  // -----------------------------------------------------------------------

  it("should calculate Sharpe ratio, max drawdown, and win rate", () => {
    const decisions: Decision[] = [
      { pendingId: "1", content: "Buy AAPL", outcome: { raw: {}, outcome: "success", summary: "ok", metrics: { actualReturn: 0.08 } }, reflection: "good", resolvedAt: "2024-01-15" },
      { pendingId: "2", content: "Buy GOOG", outcome: { raw: {}, outcome: "success", summary: "ok", metrics: { actualReturn: 0.05 } }, reflection: "ok", resolvedAt: "2024-01-16" },
      { pendingId: "3", content: "Buy NVDA", outcome: { raw: {}, outcome: "failure", summary: "bad", metrics: { actualReturn: -0.03 } }, reflection: "learn", resolvedAt: "2024-01-17" },
    ];

    const metrics = tradingAdapter.metricsCalculator(decisions);
    expect(typeof metrics.sharpeRatio).toBe("number");
    expect(typeof metrics.maxDrawdown).toBe("number");
    expect(typeof metrics.winRate).toBe("number");
    expect(metrics.totalDecisions).toBe(3);
    expect((metrics.winRate as number)).toBeCloseTo(0.6667, 3);
  });

  it("should handle empty decisions array", () => {
    const metrics = tradingAdapter.metricsCalculator([]);
    expect(metrics.totalDecisions).toBe(0);
    expect(metrics.sharpeRatio).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Seed knowledge
  // -----------------------------------------------------------------------

  it("should return S&P 500 sectors and major indices", async () => {
    const seed = await tradingAdapter.seedKnowledge!();
    expect(seed.entities.length).toBeGreaterThan(10);
    expect(seed.entities.some((e) => e.type === "Sector")).toBe(true);
    expect(seed.entities.some((e) => e.type === "Index")).toBe(true);
    expect(seed.relations.length).toBeGreaterThan(0);
    expect(seed.relations.every((r) => r.type === "MEMBER_OF")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Entity schemas
  // -----------------------------------------------------------------------

  it("should include all 7 entity schemas", () => {
    expect(tradingAdapter.entitySchemas.length).toBe(7);
  });

  it("should validate valid Ticker data", () => {
    const result = TickerSchema.safeParse({
      symbol: "AAPL", name: "Apple Inc.", sector: "Technology", exchange: "NASDAQ",
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid Ticker data", () => {
    const result = TickerSchema.safeParse({
      symbol: "", name: "Apple Inc.", sector: "Technology", exchange: "NASDAQ",
    });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Prompt packs
  // -----------------------------------------------------------------------

  it("should reference 5 prompt packs", () => {
    const packs = Object.keys(tradingAdapter.promptPacks);
    expect(packs.length).toBe(5);
    expect(packs).toContain("fundamentals");
    expect(packs).toContain("technical");
    expect(packs).toContain("sentiment");
    expect(packs).toContain("debate");
    expect(packs).toContain("research");
  });
});
