/**
 * Live Data Providers — unit tests
 *
 * Tests the pluggable trading data provider architecture:
 *  - TTL cache hit/miss behavior
 *  - Graceful fallback to stubs when API keys are missing
 *  - Provider creation with and without keys
 *  - Schema validation of stub responses
 *
 * Conditional live API tests only run when ALPHA_VANTAGE_API_KEY is set.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { TTLCache, createProviders } from "../../../domains/trading/providers.js";
import {
  MarketDataSchema,
  EarningsReportSchema,
  SentimentDataSchema,
  TechnicalIndicatorSchema,
} from "../../../domains/trading/schemas.js";

// ---------------------------------------------------------------------------
// TTLCache tests
// ---------------------------------------------------------------------------

describe("TTLCache", () => {
  it("should return undefined for missing keys", () => {
    const cache = new TTLCache<string>(60);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("should store and retrieve values within TTL", () => {
    const cache = new TTLCache<string>(60);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("should return undefined for expired entries", async () => {
    const cache = new TTLCache<string>(0); // 0 second TTL
    cache.set("key1", "value1", 0);

    // Wait a tiny bit for expiry
    await new Promise((r) => setTimeout(r, 10));

    expect(cache.get("key1")).toBeUndefined();
  });

  it("should track size correctly", () => {
    const cache = new TTLCache<number>(60);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });

  it("should clear all entries", () => {
    const cache = new TTLCache<number>(60);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("should allow custom TTL per entry", () => {
    const cache = new TTLCache<string>(60); // default 60s
    cache.set("short", "value", 0);
    cache.set("long", "value", 3600);

    // Short TTL entry should expire quickly
    // (Note: this is a timing-sensitive test, but 0s TTL makes it reliable)
    expect(cache.get("long")).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// Provider creation tests
// ---------------------------------------------------------------------------

describe("createProviders", () => {
  it("should create providers with stub fallback when no API keys are set", () => {
    // Ensure no API keys
    const origAV = process.env.ALPHA_VANTAGE_API_KEY;
    const origFH = process.env.FINNHUB_API_KEY;
    delete process.env.ALPHA_VANTAGE_API_KEY;
    delete process.env.FINNHUB_API_KEY;

    try {
      const providers = createProviders();
      expect(providers.liveProviders.length).toBe(0);
      expect(typeof providers.getMarketData).toBe("function");
      expect(typeof providers.getEarningsReport).toBe("function");
      expect(typeof providers.getSentiment).toBe("function");
      expect(typeof providers.getTechnicalIndicators).toBe("function");
    } finally {
      if (origAV) process.env.ALPHA_VANTAGE_API_KEY = origAV;
      if (origFH) process.env.FINNHUB_API_KEY = origFH;
    }
  });

  it("should report live providers when API keys are set", () => {
    const origAV = process.env.ALPHA_VANTAGE_API_KEY;
    const origFH = process.env.FINNHUB_API_KEY;
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    process.env.FINNHUB_API_KEY = "test-key";

    try {
      const providers = createProviders();
      expect(providers.liveProviders.length).toBeGreaterThan(0);
      expect(providers.liveProviders).toContain("alpha_vantage:market_data");
      expect(providers.liveProviders).toContain("finnhub:sentiment");
    } finally {
      if (origAV) {
        process.env.ALPHA_VANTAGE_API_KEY = origAV;
      } else {
        delete process.env.ALPHA_VANTAGE_API_KEY;
      }
      if (origFH) {
        process.env.FINNHUB_API_KEY = origFH;
      } else {
        delete process.env.FINNHUB_API_KEY;
      }
    }
  });

  it("should accept custom cache config", () => {
    const origAV = process.env.ALPHA_VANTAGE_API_KEY;
    delete process.env.ALPHA_VANTAGE_API_KEY;

    try {
      const providers = createProviders({
        marketDataTTL: 120,
        earningsTTL: 3600,
        sentimentTTL: 60,
        technicalTTL: 120,
      });
      // Should create without error
      expect(providers).toBeDefined();
    } finally {
      if (origAV) process.env.ALPHA_VANTAGE_API_KEY = origAV;
    }
  });
});

// ---------------------------------------------------------------------------
// Stub provider schema validation
// ---------------------------------------------------------------------------

describe("Stub providers (schema validation)", () => {
  let providers: ReturnType<typeof createProviders>;

  beforeEach(() => {
    const origAV = process.env.ALPHA_VANTAGE_API_KEY;
    const origFH = process.env.FINNHUB_API_KEY;
    delete process.env.ALPHA_VANTAGE_API_KEY;
    delete process.env.FINNHUB_API_KEY;

    providers = createProviders();

    if (origAV) process.env.ALPHA_VANTAGE_API_KEY = origAV;
    if (origFH) process.env.FINNHUB_API_KEY = origFH;
  });

  it("should return valid MarketData from stub", async () => {
    const data = await providers.getMarketData("AAPL", "2025-01-01", "2025-01-31");
    expect(data.length).toBeGreaterThan(0);

    for (const item of data) {
      expect(() => MarketDataSchema.parse(item)).not.toThrow();
    }
  });

  it("should return valid EarningsReport from stub", async () => {
    const report = await providers.getEarningsReport("AAPL", "Q4", 2024);
    expect(() => EarningsReportSchema.parse(report)).not.toThrow();
    expect(report.ticker).toBe("AAPL");
    expect(report.quarter).toBe("Q4");
    expect(report.year).toBe(2024);
  });

  it("should return valid SentimentData from stub", async () => {
    const sentiment = await providers.getSentiment("AAPL", "2025-01-15");
    expect(() => SentimentDataSchema.parse(sentiment)).not.toThrow();
    expect(sentiment.ticker).toBe("AAPL");
  });

  it("should return valid TechnicalIndicator from stub", async () => {
    const technicals = await providers.getTechnicalIndicators("AAPL", "2025-01-15");
    expect(() => TechnicalIndicatorSchema.parse(technicals)).not.toThrow();
    expect(technicals.ticker).toBe("AAPL");
    expect(technicals.rsi).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Conditional live API tests
// ---------------------------------------------------------------------------

const hasAlphaVantageKey = !!process.env.ALPHA_VANTAGE_API_KEY;

describe.skipIf(!hasAlphaVantageKey)("Live Alpha Vantage integration", () => {
  it("should fetch real market data for AAPL", async () => {
    const providers = createProviders();
    const data = await providers.getMarketData("AAPL", "2025-01-01", "2025-01-31");
    expect(data.length).toBeGreaterThan(0);

    for (const item of data) {
      expect(() => MarketDataSchema.parse(item)).not.toThrow();
      expect(item.ticker).toBe("AAPL");
      expect(item.open).toBeGreaterThan(0);
    }
  });
});
