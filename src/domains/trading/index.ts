/**
 * Trading Domain — Barrel Export
 *
 * Public API for the trading domain adapter.
 *
 * Usage:
 *   import { tradingAdapter, registerTradingRoles } from './domains/trading/index.js';
 *   DomainRegistry.getInstance().register(tradingAdapter);
 *   registerTradingRoles();
 */

export { tradingAdapter } from "./adapter.js";
export { registerTradingRoles } from "./roles.js";
export {
  TickerSchema,
  SectorSchema,
  EarningsReportSchema,
  TechnicalIndicatorSchema,
  MarketDataSchema,
  SentimentDataSchema,
  NewsEventSchema,
  type Ticker,
  type Sector,
  type EarningsReport,
  type TechnicalIndicator,
  type MarketData,
  type SentimentData,
  type NewsEvent,
} from "./schemas.js";
