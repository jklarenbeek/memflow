/**
 * Trading Domain — Pluggable Data Providers
 *
 * Production-ready data provider implementations with:
 *  - Pluggable provider interface (swap APIs without adapter changes)
 *  - In-memory TTL cache (configurable per provider)
 *  - Graceful fallback to stub data when API keys are missing
 *  - Zod-validated responses
 *
 * Reference implementations:
 *  - Alpha Vantage: market data, earnings, technical indicators
 *  - FinnHub: multi-source sentiment scores
 *
 * To add a new provider:
 *  1. Implement the relevant `*ProviderFn` type
 *  2. Register it in the `providers` map
 *  3. Set the API key env var
 */

import {
  MarketDataSchema,
  EarningsReportSchema,
  SentimentDataSchema,
  TechnicalIndicatorSchema,
  type MarketData,
  type EarningsReport,
  type SentimentData,
  type TechnicalIndicator,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Simple in-memory TTL cache.
 *
 * Mitigates API rate limits (Alpha Vantage free tier: 25 req/day,
 * FinnHub free tier: 60 req/min) by caching responses for a
 * configurable duration.
 */
export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private readonly defaultTTLSeconds: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlSeconds?: number): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + (ttlSeconds ?? this.defaultTTLSeconds) * 1000,
    });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Provider function types (pluggable interface)
// ---------------------------------------------------------------------------

export type MarketDataProviderFn = (
  ticker: string,
  startDate: string,
  endDate: string,
) => Promise<MarketData[]>;

export type EarningsProviderFn = (
  ticker: string,
  quarter: string,
  year: number,
) => Promise<EarningsReport>;

export type SentimentProviderFn = (
  ticker: string,
  date: string,
) => Promise<SentimentData>;

export type TechnicalIndicatorProviderFn = (
  ticker: string,
  date: string,
) => Promise<TechnicalIndicator>;

// ---------------------------------------------------------------------------
// Cache configuration
// ---------------------------------------------------------------------------

export interface ProviderCacheConfig {
  /** Market data cache TTL in seconds (default: 900 = 15 min) */
  marketDataTTL?: number;
  /** Earnings report cache TTL in seconds (default: 86400 = 24h) */
  earningsTTL?: number;
  /** Sentiment data cache TTL in seconds (default: 300 = 5 min) */
  sentimentTTL?: number;
  /** Technical indicators cache TTL in seconds (default: 900 = 15 min) */
  technicalTTL?: number;
}

// ---------------------------------------------------------------------------
// Stub providers (fallback when API keys are missing)
// ---------------------------------------------------------------------------

const stubMarketData: MarketDataProviderFn = async (ticker, startDate) => {
  return [
    MarketDataSchema.parse({
      ticker,
      date: startDate,
      open: 171.13,
      high: 171.61,
      low: 169.90,
      close: 170.86,
      adjustedClose: 170.86,
      volume: 125_000_000,
    }),
  ];
};

const stubEarnings: EarningsProviderFn = async (ticker, quarter, year) => {
  return EarningsReportSchema.parse({
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
  });
};

const stubSentiment: SentimentProviderFn = async (ticker, date) => {
  return SentimentDataSchema.parse({
    ticker,
    date,
    overallScore: 0.35,
    newsSentiment: 0.42,
    socialSentiment: 0.28,
    insiderSentiment: 0.15,
    socialMentions: 12_450,
    newsVolume: 87,
    sources: ["Reddit", "X/Twitter", "Bloomberg", "Reuters"],
  });
};

const stubTechnicals: TechnicalIndicatorProviderFn = async (ticker, date) => {
  return TechnicalIndicatorSchema.parse({
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
  });
};

// ---------------------------------------------------------------------------
// Alpha Vantage providers
// ---------------------------------------------------------------------------

/**
 * Fetch market OHLCV data from Alpha Vantage TIME_SERIES_DAILY_ADJUSTED.
 *
 * Paper §5.2: "historical stock prices — open, high, low, close, volume"
 */
function createAlphaVantageMarketData(apiKey: string, cache: TTLCache<MarketData[]>): MarketDataProviderFn {
  return async (ticker, startDate, endDate) => {
    const cacheKey = `market:${ticker}:${startDate}:${endDate}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}&outputsize=full`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Alpha Vantage market data error: ${resp.status} ${resp.statusText}`);
    const json = await resp.json() as Record<string, unknown>;

    const timeSeries = json["Time Series (Daily)"] as Record<string, Record<string, string>> | undefined;
    if (!timeSeries) {
      throw new Error(`Alpha Vantage: no time series data for ${ticker}. Response: ${JSON.stringify(json).substring(0, 200)}`);
    }

    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    const result: MarketData[] = [];
    for (const [date, values] of Object.entries(timeSeries)) {
      const dateMs = new Date(date).getTime();
      if (dateMs >= start && dateMs <= end) {
        result.push(
          MarketDataSchema.parse({
            ticker,
            date,
            open: parseFloat(values["1. open"]),
            high: parseFloat(values["2. high"]),
            low: parseFloat(values["3. low"]),
            close: parseFloat(values["4. close"]),
            adjustedClose: parseFloat(values["5. adjusted close"]),
            volume: parseInt(values["6. volume"], 10),
          }),
        );
      }
    }

    // Sort chronologically
    result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    cache.set(cacheKey, result);
    return result;
  };
}

/**
 * Fetch quarterly earnings from Alpha Vantage EARNINGS.
 *
 * Paper §3.1: "Fundamental Analyst — financial statements, earnings reports"
 */
function createAlphaVantageEarnings(apiKey: string, cache: TTLCache<EarningsReport>): EarningsProviderFn {
  return async (ticker, quarter, year) => {
    const cacheKey = `earnings:${ticker}:${quarter}:${year}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Alpha Vantage earnings error: ${resp.status}`);
    const json = await resp.json() as Record<string, unknown>;

    const quarterly = json["quarterlyEarnings"] as Array<Record<string, string>> | undefined;
    if (!quarterly || quarterly.length === 0) {
      throw new Error(`Alpha Vantage: no earnings data for ${ticker}`);
    }

    // Find matching quarter
    const quarterMap: Record<string, string[]> = {
      Q1: ["01", "02", "03"],
      Q2: ["04", "05", "06"],
      Q3: ["07", "08", "09"],
      Q4: ["10", "11", "12"],
    };
    const months = quarterMap[quarter] ?? quarterMap.Q4;

    const match = quarterly.find((e) => {
      const reportDate = e["reportedDate"] ?? "";
      const reportYear = reportDate.substring(0, 4);
      const reportMonth = reportDate.substring(5, 7);
      return reportYear === String(year) && months.includes(reportMonth);
    }) ?? quarterly[0];

    const result = EarningsReportSchema.parse({
      ticker,
      quarter,
      year,
      revenue: 0, // Alpha Vantage EARNINGS doesn't include revenue
      eps: parseFloat(match["reportedEPS"] ?? "0"),
      epsEstimate: parseFloat(match["estimatedEPS"] ?? "0"),
      netIncome: 0,
      grossMargin: 0,
      operatingMargin: 0,
      peRatio: 0,
      roe: 0,
      debtToEquity: 0,
      reportDate: match["reportedDate"] ?? `${year}-01-01`,
    });

    cache.set(cacheKey, result);
    return result;
  };
}

/**
 * Fetch RSI, MACD, and Bollinger Bands from Alpha Vantage.
 *
 * Paper §3.1: "Technical Analyst — MACD, RSI... 60 standard technical analysis indicators"
 */
function createAlphaVantageTechnicals(apiKey: string, cache: TTLCache<TechnicalIndicator>): TechnicalIndicatorProviderFn {
  return async (ticker, date) => {
    const cacheKey = `technicals:${ticker}:${date}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Fetch RSI, MACD, BBANDS in parallel
    const [rsiResp, macdResp, bbandsResp] = await Promise.all([
      fetch(`https://www.alphavantage.co/query?function=RSI&symbol=${encodeURIComponent(ticker)}&interval=daily&time_period=14&series_type=close&apikey=${apiKey}`),
      fetch(`https://www.alphavantage.co/query?function=MACD&symbol=${encodeURIComponent(ticker)}&interval=daily&series_type=close&apikey=${apiKey}`),
      fetch(`https://www.alphavantage.co/query?function=BBANDS&symbol=${encodeURIComponent(ticker)}&interval=daily&time_period=20&series_type=close&apikey=${apiKey}`),
    ]);

    const [rsiJson, macdJson, bbandsJson] = await Promise.all([
      rsiResp.json() as Promise<Record<string, unknown>>,
      macdResp.json() as Promise<Record<string, unknown>>,
      bbandsResp.json() as Promise<Record<string, unknown>>,
    ]);

    // Extract latest values
    const rsiData = rsiJson["Technical Analysis: RSI"] as Record<string, Record<string, string>> | undefined;
    const macdData = macdJson["Technical Analysis: MACD"] as Record<string, Record<string, string>> | undefined;
    const bbandsData = bbandsJson["Technical Analysis: BBANDS"] as Record<string, Record<string, string>> | undefined;

    const latestRsi = rsiData ? Object.values(rsiData)[0] : undefined;
    const latestMacd = macdData ? Object.values(macdData)[0] : undefined;
    const latestBbands = bbandsData ? Object.values(bbandsData)[0] : undefined;

    const result = TechnicalIndicatorSchema.parse({
      ticker,
      date,
      rsi: latestRsi ? parseFloat(latestRsi["RSI"]) : 50,
      macd: {
        value: latestMacd ? parseFloat(latestMacd["MACD"]) : 0,
        signal: latestMacd ? parseFloat(latestMacd["MACD_Signal"]) : 0,
        histogram: latestMacd ? parseFloat(latestMacd["MACD_Hist"]) : 0,
      },
      bollingerBands: {
        upper: latestBbands ? parseFloat(latestBbands["Real Upper Band"]) : 0,
        middle: latestBbands ? parseFloat(latestBbands["Real Middle Band"]) : 0,
        lower: latestBbands ? parseFloat(latestBbands["Real Lower Band"]) : 0,
      },
      sma20: latestBbands ? parseFloat(latestBbands["Real Middle Band"]) : 0,
      sma50: 0,
      sma200: 0,
      adx: 0,
      volume: 0,
      vwap: 0,
    });

    cache.set(cacheKey, result);
    return result;
  };
}

// ---------------------------------------------------------------------------
// FinnHub provider
// ---------------------------------------------------------------------------

/**
 * Fetch sentiment from FinnHub news-sentiment API.
 *
 * Paper §3.1: "Sentiment Analyst — social media posts, sentiment scores,
 * insider sentiments... gauge market sentiment"
 */
function createFinnHubSentiment(apiKey: string, cache: TTLCache<SentimentData>): SentimentProviderFn {
  return async (ticker, date) => {
    const cacheKey = `sentiment:${ticker}:${date}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const from = date;
    const to = date;
    const url = `https://finnhub.io/api/v1/news-sentiment?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${apiKey}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`FinnHub sentiment error: ${resp.status}`);
    const json = await resp.json() as Record<string, unknown>;

    const sentiment = json["sentiment"] as Record<string, number> | undefined;
    const buzz = json["buzz"] as Record<string, number> | undefined;

    const result = SentimentDataSchema.parse({
      ticker,
      date,
      overallScore: sentiment?.["score"] ?? 0,
      newsSentiment: sentiment?.["bearishPercent"] !== undefined
        ? 1 - sentiment["bearishPercent"]
        : 0.5,
      socialSentiment: 0, // FinnHub doesn't provide social separately
      insiderSentiment: 0,
      socialMentions: buzz?.["buzz"] ?? 0,
      newsVolume: buzz?.["articlesInLastWeek"] ?? 0,
      sources: ["FinnHub"],
    });

    cache.set(cacheKey, result);
    return result;
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Provider registry — maps provider names to their implementations.
 *
 * Pluggable design: add new providers by registering them here.
 * The adapter selects which provider to use based on available API keys.
 */
export interface ResolvedProviders {
  getMarketData: MarketDataProviderFn;
  getEarningsReport: EarningsProviderFn;
  getSentiment: SentimentProviderFn;
  getTechnicalIndicators: TechnicalIndicatorProviderFn;
  /** Which providers are using live APIs (vs stubs) */
  liveProviders: string[];
}

/**
 * Create resolved providers based on available API keys.
 *
 * Falls back to stub data when keys are missing — no runtime errors
 * for optional configuration.
 *
 * @param cacheConfig - Optional TTL configuration per provider
 */
export function createProviders(cacheConfig?: ProviderCacheConfig): ResolvedProviders {
  const alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;
  const finnHubKey = process.env.FINNHUB_API_KEY;
  const liveProviders: string[] = [];

  // Parse cache TTLs from env or config
  const marketTTL = cacheConfig?.marketDataTTL
    ?? parseInt(process.env.MARKET_DATA_CACHE_TTL ?? "900", 10);
  const earningsTTL = cacheConfig?.earningsTTL ?? 86400;
  const sentimentTTL = cacheConfig?.sentimentTTL ?? 300;
  const technicalTTL = cacheConfig?.technicalTTL ?? 900;

  // Caches
  const marketCache = new TTLCache<MarketData[]>(marketTTL);
  const earningsCache = new TTLCache<EarningsReport>(earningsTTL);
  const sentimentCache = new TTLCache<SentimentData>(sentimentTTL);
  const technicalCache = new TTLCache<TechnicalIndicator>(technicalTTL);

  // Select providers based on available keys
  let getMarketData: MarketDataProviderFn;
  let getEarningsReport: EarningsProviderFn;
  let getTechnicalIndicators: TechnicalIndicatorProviderFn;
  let getSentiment: SentimentProviderFn;

  if (alphaVantageKey) {
    getMarketData = createAlphaVantageMarketData(alphaVantageKey, marketCache);
    getEarningsReport = createAlphaVantageEarnings(alphaVantageKey, earningsCache);
    getTechnicalIndicators = createAlphaVantageTechnicals(alphaVantageKey, technicalCache);
    liveProviders.push("alpha_vantage:market_data", "alpha_vantage:earnings", "alpha_vantage:technicals");
  } else {
    getMarketData = stubMarketData;
    getEarningsReport = stubEarnings;
    getTechnicalIndicators = stubTechnicals;
  }

  if (finnHubKey) {
    getSentiment = createFinnHubSentiment(finnHubKey, sentimentCache);
    liveProviders.push("finnhub:sentiment");
  } else {
    getSentiment = stubSentiment;
  }

  return {
    getMarketData,
    getEarningsReport,
    getSentiment,
    getTechnicalIndicators,
    liveProviders,
  };
}
