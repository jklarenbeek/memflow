/**
 * Trading Domain — Extended Roles
 *
 * Domain-specialized roles registered via RoleRegistry.extend().
 * These extend the core analyst roles (fundamentals_analyst, technical_analyst,
 * sentiment_analyst, risk_assessor) with trading-specific prompt packs and
 * descriptions based on TradingAgents (arXiv:2412.20138v7).
 *
 * The base analyst roles are domain-agnostic and live in the core RoleRegistry.
 * This file adds trading-specific overrides (prompt packs, descriptions).
 *
 * Usage:
 *   import { registerTradingRoles } from './domains/trading/roles.js';
 *   registerTradingRoles();
 *   // Now RoleRegistry.getInstance().get('trading_fundamentals_analyst') works
 */

import { RoleRegistry } from "../../gmpl/RoleRegistry.js";

/**
 * Register all trading-domain-specialized roles.
 *
 * Idempotent — skips roles that are already registered.
 * Call this after DomainRegistry.register(tradingAdapter).
 */
export function registerTradingRoles(): void {
  const registry = RoleRegistry.getInstance();

  // Trading Fundamental Analyst — extends core fundamentals_analyst
  // Paper §3.1: "evaluate company fundamentals by analyzing financial
  // statements, earnings reports, insider transactions... assess intrinsic value"
  if (!registry.has("trading_fundamentals_analyst")) {
    registry.extend("trading_fundamentals_analyst", "fundamentals_analyst", {
      description:
        "Analyzes company fundamentals: earnings, revenue, P/E ratios, " +
        "ROE, debt-to-equity, gross/operating margins. Assesses intrinsic value.",
      promptPack: "trading/fundamentals",
    });
  }

  // Trading Technical Analyst — extends core technical_analyst
  // Paper §3.1: "calculate and select relevant technical indicators, such as
  // MACD and RSI, customized for specific assets... analyze price patterns"
  if (!registry.has("trading_technical_analyst")) {
    registry.extend("trading_technical_analyst", "technical_analyst", {
      description:
        "Analyzes price patterns using technical indicators: RSI, MACD, " +
        "Bollinger Bands, SMA, ADX. Forecasts entry/exit points.",
      promptPack: "trading/technical",
    });
  }

  // Trading Sentiment Analyst — extends core sentiment_analyst
  // Paper §3.1: "process large volumes of social media posts, sentiment scores,
  // and insider sentiments... gauge market sentiment"
  if (!registry.has("trading_sentiment_analyst")) {
    registry.extend("trading_sentiment_analyst", "sentiment_analyst", {
      description:
        "Gauges market sentiment from social media, news, and insider activity. " +
        "Predicts short-term investor behavior impact on price.",
      promptPack: "trading/sentiment",
    });
  }

  // Trading Risk Assessor — extends core risk_assessor
  // Paper §3.4: "Risk Management Team — risky, neutral, and risk-conservative
  // perspectives to adjust the trading plan within risk constraints"
  if (!registry.has("trading_risk_assessor")) {
    registry.extend("trading_risk_assessor", "risk_assessor", {
      description:
        "Evaluates portfolio risk exposure: market volatility, liquidity, " +
        "counterparty risks. Provides risky/neutral/safe perspectives.",
      promptPack: "trading/research",
      requiredModules: ["OutcomeMemory"],
    });
  }
}
