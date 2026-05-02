/**
 * Trading Domain — Entity Schemas
 *
 * Zod schemas and TypeScript types for TradingAgents-inspired entities.
 * Based on arXiv:2412.20138v7 (Xiao et al.):
 *   - Fundamental Analyst → EarningsReport, FinancialStatement
 *   - Technical Analyst → TechnicalIndicator (RSI, MACD, Bollinger, etc.)
 *   - Sentiment Analyst → SentimentData (social media, news sentiment)
 *   - News Analyst → NewsEvent
 *   - Market data → Ticker, Sector, MarketData
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export const TickerSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  sector: z.string(),
  exchange: z.string(),
  marketCap: z.number().optional(),
});

export type Ticker = z.infer<typeof TickerSchema>;

export const SectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tickers: z.array(z.string()),
});

export type Sector = z.infer<typeof SectorSchema>;

// ---------------------------------------------------------------------------
// Fundamental analysis (paper §3.1: Fundamental Analyst)
// ---------------------------------------------------------------------------

export const EarningsReportSchema = z.object({
  ticker: z.string(),
  quarter: z.string(),
  year: z.number(),
  revenue: z.number(),
  eps: z.number(),
  epsEstimate: z.number().optional(),
  netIncome: z.number(),
  grossMargin: z.number().min(0).max(1),
  operatingMargin: z.number(),
  peRatio: z.number().optional(),
  roe: z.number().optional(),
  debtToEquity: z.number().optional(),
  reportDate: z.string(),
});

export type EarningsReport = z.infer<typeof EarningsReportSchema>;

// ---------------------------------------------------------------------------
// Technical analysis (paper §3.1: Technical Analyst — 60 indicators)
// ---------------------------------------------------------------------------

export const TechnicalIndicatorSchema = z.object({
  ticker: z.string(),
  date: z.string(),
  rsi: z.number().min(0).max(100),
  macd: z.object({
    value: z.number(),
    signal: z.number(),
    histogram: z.number(),
  }),
  bollingerBands: z.object({
    upper: z.number(),
    middle: z.number(),
    lower: z.number(),
  }),
  sma20: z.number(),
  sma50: z.number(),
  sma200: z.number(),
  adx: z.number().optional(),
  volume: z.number(),
  vwap: z.number().optional(),
});

export type TechnicalIndicator = z.infer<typeof TechnicalIndicatorSchema>;

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export const MarketDataSchema = z.object({
  ticker: z.string(),
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  adjustedClose: z.number(),
  volume: z.number(),
});

export type MarketData = z.infer<typeof MarketDataSchema>;

// ---------------------------------------------------------------------------
// Sentiment analysis (paper §3.1: Sentiment Analyst — social media + news)
// ---------------------------------------------------------------------------

export const SentimentDataSchema = z.object({
  ticker: z.string(),
  date: z.string(),
  /** Overall sentiment score (-1 to 1) */
  overallScore: z.number().min(-1).max(1),
  /** News sentiment */
  newsSentiment: z.number().min(-1).max(1),
  /** Social media sentiment (Reddit, X/Twitter) */
  socialSentiment: z.number().min(-1).max(1),
  /** Insider sentiment derived from public filings */
  insiderSentiment: z.number().min(-1).max(1).optional(),
  /** Number of social media mentions */
  socialMentions: z.number().optional(),
  /** Volume of news articles */
  newsVolume: z.number().optional(),
  sources: z.array(z.string()).optional(),
});

export type SentimentData = z.infer<typeof SentimentDataSchema>;

// ---------------------------------------------------------------------------
// News events (paper §3.1: News Analyst — macro/company/sector events)
// ---------------------------------------------------------------------------

export const NewsEventSchema = z.object({
  ticker: z.string().optional(),
  headline: z.string(),
  source: z.string(),
  category: z.enum(["company", "sector", "macro", "geopolitical", "regulatory"]),
  sentiment: z.number().min(-1).max(1),
  date: z.string(),
  summary: z.string().optional(),
});

export type NewsEvent = z.infer<typeof NewsEventSchema>;
