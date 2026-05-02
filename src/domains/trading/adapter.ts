/**
 * Trading Domain Adapter — reference DomainAdapter implementation
 *
 * Demonstrates the full DomainAdapter plugin contract using the TradingAgents
 * architecture (arXiv:2412.20138v7, Xiao et al.) as the reference domain.
 *
 * Agent structure from the paper:
 *   I.   Analyst Team (Fundamental, Sentiment, News, Technical)
 *   II.  Researcher Team (Bullish/Bearish debate)
 *   III. Trader (decision signals + rationale)
 *   IV.  Risk Management (Risky/Neutral/Safe perspectives)
 *   V.   Fund Manager (final approval)
 *
 * Metrics from the paper (Appendix S1.2):
 *   - Cumulative Return (CR), Annualized Return (AR)
 *   - Sharpe Ratio (SR), Maximum Drawdown (MDD)
 *
 * Data providers return mock data structures to demonstrate the contract.
 * Replace with live API integration (Alpha Vantage, Yahoo Finance, etc.)
 * for production use.
 */

import type { DomainAdapter, DataProviderFn } from "../../gmpl/types.js";
import type { PendingDecision, OutcomeResult, Decision } from "../../gmpl/types.js";
import type { KGSeed } from "../../gmpl/types.js";

import {
  TickerSchema,
  SectorSchema,
  EarningsReportSchema,
  TechnicalIndicatorSchema,
  MarketDataSchema,
  SentimentDataSchema,
  NewsEventSchema,
  type MarketData,
  type EarningsReport,
  type SentimentData,
  type TechnicalIndicator,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Data providers (stub implementations for reference)
// ---------------------------------------------------------------------------

/**
 * Fetch market OHLCV data for a ticker.
 *
 * In production: call Alpha Vantage, Yahoo Finance, or EODHD API.
 * Paper §5.2: "historical stock prices — open, high, low, close, volume"
 */
async function getMarketData(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<MarketData[]> {
  // Stub: returns a single representative day
  return [
    {
      ticker,
      date: startDate,
      open: 171.13,
      high: 171.61,
      low: 169.90,
      close: 170.86,
      adjustedClose: 170.86,
      volume: 125_000_000,
    },
  ];
}

/**
 * Fetch quarterly earnings report.
 *
 * Paper §3.1: "Fundamental Analyst — financial statements, earnings reports,
 * insider transactions... assess intrinsic value"
 */
async function getEarningsReport(
  ticker: string,
  quarter: string,
  year: number,
): Promise<EarningsReport> {
  return {
    ticker,
    quarter,
    year,
    revenue: 94_930_000_000,
    eps: 1.64,
    epsEstimate: 1.60,
    netIncome: 25_010_000_000,
    grossMargin: 0.462,
    operatingMargin: 0.306,
    peRatio: 28.5,
    roe: 1.71,
    debtToEquity: 1.87,
    reportDate: `${year}-${quarter === "Q4" ? "10" : "07"}-28`,
  };
}

/**
 * Fetch social/news sentiment data.
 *
 * Paper §3.1: "Sentiment Analyst — social media posts, sentiment scores,
 * insider sentiments... gauge market sentiment"
 */
async function getSentiment(
  ticker: string,
  date: string,
): Promise<SentimentData> {
  return {
    ticker,
    date,
    overallScore: 0.35,
    newsSentiment: 0.42,
    socialSentiment: 0.28,
    insiderSentiment: 0.15,
    socialMentions: 12_450,
    newsVolume: 87,
    sources: ["Reddit", "X/Twitter", "Bloomberg", "Reuters"],
  };
}

/**
 * Fetch technical indicators (RSI, MACD, Bollinger, SMA).
 *
 * Paper §3.1: "Technical Analyst — MACD, RSI... calculate and select
 * relevant technical indicators... 60 standard technical analysis indicators"
 */
async function getTechnicalIndicators(
  ticker: string,
  date: string,
): Promise<TechnicalIndicator> {
  return {
    ticker,
    date,
    rsi: 62.5,
    macd: { value: 1.25, signal: 0.98, histogram: 0.27 },
    bollingerBands: { upper: 178.50, middle: 172.30, lower: 166.10 },
    sma20: 172.15,
    sma50: 169.80,
    sma200: 165.40,
    adx: 28.3,
    volume: 125_000_000,
    vwap: 171.02,
  };
}

// ---------------------------------------------------------------------------
// Outcome evaluator
// ---------------------------------------------------------------------------

/**
 * Compare predicted returns vs actual returns.
 *
 * Maps to the paper's evaluation metrics (§S1.2):
 *   - ±5% tolerance → partial
 *   - Correct direction with >5% → success
 *   - Wrong direction → failure
 */
async function outcomeEvaluator(
  pending: PendingDecision,
  context: Record<string, unknown>,
): Promise<OutcomeResult> {
  const predictedReturn = (context.predictedReturn as number) ?? 0;
  const actualReturn = (context.actualReturn as number) ?? 0;
  const diff = Math.abs(predictedReturn - actualReturn);
  const sameDirection =
    (predictedReturn >= 0 && actualReturn >= 0) ||
    (predictedReturn < 0 && actualReturn < 0);

  if (sameDirection && diff < 0.05) {
    return {
      raw: context,
      outcome: "success",
      summary: `Predicted ${(predictedReturn * 100).toFixed(1)}%, actual ${(actualReturn * 100).toFixed(1)}%. Direction correct, within 5% tolerance.`,
      metrics: { predictedReturn, actualReturn, diff },
    };
  }

  if (sameDirection) {
    return {
      raw: context,
      outcome: "partial",
      summary: `Predicted ${(predictedReturn * 100).toFixed(1)}%, actual ${(actualReturn * 100).toFixed(1)}%. Direction correct but magnitude off by ${(diff * 100).toFixed(1)}%.`,
      metrics: { predictedReturn, actualReturn, diff },
    };
  }

  return {
    raw: context,
    outcome: "failure",
    summary: `Predicted ${(predictedReturn * 100).toFixed(1)}%, actual ${(actualReturn * 100).toFixed(1)}%. Wrong direction.`,
    metrics: { predictedReturn, actualReturn, diff },
  };
}

// ---------------------------------------------------------------------------
// Metrics calculator (paper §S1.2: SR, MDD, win rate)
// ---------------------------------------------------------------------------

/**
 * Calculate portfolio-level trading metrics from resolved decisions.
 *
 * Implements Sharpe Ratio (§S1.2.3), Maximum Drawdown (§S1.2.4),
 * and win rate.
 */
function metricsCalculator(
  decisions: Decision[],
): Record<string, number | string> {
  if (decisions.length === 0) {
    return { sharpeRatio: 0, maxDrawdown: 0, winRate: 0, totalDecisions: 0 };
  }

  const returns: number[] = decisions.map(
    (d) => ((d.outcome.metrics?.actualReturn as number) ?? 0),
  );
  const wins = decisions.filter((d) => d.outcome.outcome === "success").length;

  // Mean return
  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Standard deviation
  const variance =
    returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe Ratio (simplified — assumes risk-free rate = 0)
  const sharpeRatio = stdDev > 0 ? meanReturn / stdDev : 0;

  // Maximum Drawdown (peak-to-trough on cumulative returns)
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const winRate = wins / decisions.length;

  return {
    sharpeRatio: Number(sharpeRatio.toFixed(4)),
    maxDrawdown: Number(maxDrawdown.toFixed(4)),
    winRate: Number(winRate.toFixed(4)),
    totalDecisions: decisions.length,
    meanReturn: Number(meanReturn.toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// Seed knowledge
// ---------------------------------------------------------------------------

/**
 * S&P 500 sector entities and major indices.
 *
 * Provides the baseline knowledge graph structure for the trading domain.
 */
async function seedKnowledge(): Promise<KGSeed> {
  const sectors = [
    "Technology",
    "Healthcare",
    "Financials",
    "Consumer Discretionary",
    "Communication Services",
    "Industrials",
    "Consumer Staples",
    "Energy",
    "Utilities",
    "Real Estate",
    "Materials",
  ];

  const indices = [
    { name: "S&P 500", symbol: "SPX" },
    { name: "NASDAQ Composite", symbol: "IXIC" },
    { name: "Dow Jones Industrial Average", symbol: "DJI" },
    { name: "Russell 2000", symbol: "RUT" },
  ];

  return {
    entities: [
      ...sectors.map((s) => ({
        name: s,
        type: "Sector",
        description: `S&P 500 ${s} sector`,
      })),
      ...indices.map((idx) => ({
        name: idx.name,
        type: "Index",
        description: `${idx.name} (${idx.symbol})`,
      })),
    ],
    relations: [
      // Sector → Index membership
      ...sectors.map((s) => ({
        source: s,
        target: "S&P 500",
        type: "MEMBER_OF",
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

/**
 * Trading domain adapter — register via DomainRegistry.
 *
 * ```typescript
 * import { DomainRegistry } from '@memflow/gmpl';
 * import { tradingAdapter } from './domains/trading/adapter.js';
 * DomainRegistry.getInstance().register(tradingAdapter);
 * ```
 */
export const tradingAdapter: DomainAdapter = {
  id: "trading",
  version: "0.5.1",

  dataProviders: {
    getMarketData: getMarketData as DataProviderFn,
    getEarningsReport: getEarningsReport as DataProviderFn,
    getSentiment: getSentiment as DataProviderFn,
    getTechnicalIndicators: getTechnicalIndicators as DataProviderFn,
  },

  entitySchemas: [
    TickerSchema,
    SectorSchema,
    EarningsReportSchema,
    TechnicalIndicatorSchema,
    MarketDataSchema,
    SentimentDataSchema,
    NewsEventSchema,
  ],

  outcomeEvaluator,
  metricsCalculator,

  promptPacks: {
    fundamentals: { path: "trading/fundamentals", version: "0.5.1" },
    technical: { path: "trading/technical", version: "0.5.1" },
    sentiment: { path: "trading/sentiment", version: "0.5.1" },
    debate: { path: "trading/debate", version: "0.5.1" },
    research: { path: "trading/research", version: "0.5.1" },
  },

  seedKnowledge,

  customMetrics: {
    sharpeRatio: "gauge",
    maxDrawdown: "gauge",
    winRate: "gauge",
    totalDecisions: "counter",
  },
};
