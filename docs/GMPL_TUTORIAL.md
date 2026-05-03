# GMPL Tutorial — Building a Domain Adapter

> Step-by-step guide for creating a domain-specific adapter for the Generic Multi-Agent Pattern Library (GMPL).

---

## Overview

The GMPL layer is domain-agnostic by design. All domain-specific logic — data providers, entity schemas, evaluation, prompts, and knowledge — is encapsulated in a **DomainAdapter** plugin.

This tutorial walks through building the **Trading Domain Adapter** (included as a reference implementation in `src/domains/trading/`), based on the TradingAgents architecture (arXiv:2412.20138v7, Xiao et al.).

---

## 1. Define Entity Schemas

Create Zod schemas for your domain's core entities. These schemas enable:
- Runtime validation of data flowing through patterns
- Type inference for TypeScript consumers
- Automatic schema documentation

```typescript
// src/domains/trading/schemas.ts
import { z } from "zod";

export const TickerSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  sector: z.string(),
  exchange: z.string(),
  marketCap: z.number().optional(),
});

export type Ticker = z.infer<typeof TickerSchema>;

export const EarningsReportSchema = z.object({
  ticker: z.string(),
  quarter: z.string(),
  year: z.number(),
  revenue: z.number(),
  eps: z.number(),
  epsEstimate: z.number().optional(),
  netIncome: z.number(),
  grossMargin: z.number().min(0).max(1),
  // ... additional fields
});

export type EarningsReport = z.infer<typeof EarningsReportSchema>;
```

**Design rule**: Define one schema per distinct entity type. Include all fields that patterns and modules might reference.

---

## 2. Implement Data Providers

Data providers are async functions that fetch domain-specific data. They conform to the generic `DataProviderFn` type: `(...args: unknown[]) => Promise<unknown>`.

```typescript
// src/domains/trading/adapter.ts
async function getMarketData(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<MarketData[]> {
  // In production: call Alpha Vantage, Yahoo Finance, etc.
  // For reference: return mock data
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
```

**Trading domain providers** (from the paper):
| Provider | Paper Section | Data |
|---|---|---|
| `getMarketData` | §5.2 | OHLCV price data |
| `getEarningsReport` | §3.1 Fundamental Analyst | Financial statements |
| `getSentiment` | §3.1 Sentiment Analyst | Social/news sentiment |
| `getTechnicalIndicators` | §3.1 Technical Analyst | RSI, MACD, Bollinger |

---

## 3. Write an Outcome Evaluator

The outcome evaluator compares predicted outcomes against actual results. It maps to the GMPL `OutcomeResult` type (`success | failure | partial`).

```typescript
async function outcomeEvaluator(
  pending: PendingDecision,
  context: Record<string, unknown>,
): Promise<OutcomeResult> {
  const predicted = (context.predictedReturn as number) ?? 0;
  const actual = (context.actualReturn as number) ?? 0;
  const sameDirection = (predicted >= 0 && actual >= 0) || (predicted < 0 && actual < 0);

  if (sameDirection && Math.abs(predicted - actual) < 0.05) {
    return { raw: context, outcome: "success", summary: "Within tolerance." };
  }
  if (sameDirection) {
    return { raw: context, outcome: "partial", summary: "Direction correct, magnitude off." };
  }
  return { raw: context, outcome: "failure", summary: "Wrong direction." };
}
```

---

## 4. Build a Metrics Calculator

Accepts resolved `Decision[]` and returns portfolio-level metrics. The trading adapter implements:
- **Sharpe Ratio** (paper §S1.2.3): risk-adjusted return
- **Maximum Drawdown** (paper §S1.2.4): largest peak-to-trough decline
- **Win Rate**: fraction of successful decisions

```typescript
function metricsCalculator(
  decisions: Decision[],
): Record<string, number | string> {
  // Calculate mean return, std dev, Sharpe, MDD, win rate
  return { sharpeRatio, maxDrawdown, winRate, totalDecisions: decisions.length };
}
```

---

## 5. Create Domain Prompt Packs

TOML prompt packs follow the same `[meta] + [system] + [user]` structure as core GMPL prompts:

```toml
# src/prompts/trading/fundamentals.toml

[meta]
version = "0.5.1"
domain = "trading"
role = "trading_fundamentals_analyst"

[system]
content = """You are a senior fundamental analyst at a trading firm...
Respond with JSON:
{
  "analysis": "...",
  "confidence": 0.0-1.0,
  "sources": ["..."],
  "recommendations": ["..."]
}"""

[user]
content = """Company: {{ticker}}
Quarter: {{quarter}} {{year}}
{{#if earnings_data}}
Earnings Data:
{{earnings_data}}
{{/if}}
Provide your fundamental analysis."""
```

**Trading prompt packs**:
| File | Role | Purpose |
|---|---|---|
| `trading/fundamentals.toml` | `trading_fundamentals_analyst` | Earnings, P/E, ROE analysis |
| `trading/technical.toml` | `trading_technical_analyst` | RSI, MACD, SMA analysis |
| `trading/sentiment.toml` | `trading_sentiment_analyst` | Social/news sentiment |
| `trading/debate.toml` | `opposing_researcher` | Bull/bear investment debate |
| `trading/research.toml` | `trading_risk_assessor` | Risk assessment |

---

## 6. Register Extended Roles

The core `RoleRegistry` includes 11 domain-agnostic roles — including `fundamentals_analyst`, `technical_analyst`, and `sentiment_analyst`. Domain adapters **extend** these with domain-specific prompt packs and descriptions:

```typescript
// src/domains/trading/roles.ts
import { RoleRegistry } from "../../gmpl/RoleRegistry.js";

export function registerTradingRoles(): void {
  const registry = RoleRegistry.getInstance();

  if (!registry.has("trading_fundamentals_analyst")) {
    registry.extend("trading_fundamentals_analyst", "fundamentals_analyst", {
      description: "Analyzes company fundamentals: earnings, revenue, P/E ratios...",
      promptPack: "trading/fundamentals",
    });
  }

  // Repeat for technical_analyst, sentiment_analyst, risk_assessor...
}
```

After registration, the total role count grows from 11 (core) to 15 (core + 4 trading).

---

## 7. Assemble the Domain Adapter

Bundle everything into a single `DomainAdapter` object:

```typescript
export const tradingAdapter: DomainAdapter = {
  id: "trading",
  version: "0.5.1",

  dataProviders: {
    getMarketData: getMarketData as DataProviderFn,
    getEarningsReport: getEarningsReport as DataProviderFn,
    getSentiment: getSentiment as DataProviderFn,
    getTechnicalIndicators: getTechnicalIndicators as DataProviderFn,
  },

  entitySchemas: [TickerSchema, SectorSchema, ...],
  outcomeEvaluator,
  metricsCalculator,

  promptPacks: {
    fundamentals: { path: "trading/fundamentals", version: "0.5.1" },
    technical: { path: "trading/technical", version: "0.5.1" },
    // ...
  },

  seedKnowledge,
  customMetrics: { sharpeRatio: "gauge", maxDrawdown: "gauge" },

  // Optional: authority safelist for DualSourceFusionModule
  // When present, URLs matching these patterns receive elevated trust scoring.
  // When absent, authority scoring is skipped entirely.
  authoritySafelist: [".gov", ".edu", ".reuters.", ".nih.", ".who."],
};
```

---

## 8. Register and Compose

```typescript
import { DomainRegistry, generateWorkflow } from "@memflow/gmpl";
import { tradingAdapter, registerTradingRoles } from "./domains/trading/index.js";

// Register domain
DomainRegistry.getInstance().register(tradingAdapter);
registerTradingRoles();

// Compose a trading workflow
const workflow = generateWorkflow({
  name: "trading_analysis",
  domain: "trading",
  stages: [
    { id: "analyze", pattern: "parallel_analysis", config: {
      analysts: [
        { id: "fundamentals", role: "trading_fundamentals_analyst" },
        { id: "technical", role: "trading_technical_analyst" },
        { id: "sentiment", role: "trading_sentiment_analyst" },
      ],
    }},
    { id: "debate", pattern: "structured_debate", config: {
      roles: [
        { id: "bull", persona: "Bullish Researcher" },
        { id: "bear", persona: "Bearish Researcher" },
      ],
      maxRounds: 3,
    }},
  ],
  memory: { twoPhaseEnabled: true },
});
```

---

## 9. Evidence Retrieval Integration

GMPL modules can augment their LLM prompts with evidence from the knowledge graph and/or vector store using the `retrieveEvidence()` utility (`src/gmpl/retrieveEvidence.ts`).

The `DebateModule` integrates this automatically when `evidenceRetrieval` is set to `graph`, `vector`, or `hybrid`:

```typescript
// Pattern composition with evidence retrieval
const workflow = generateWorkflow({
  name: "evidence_backed_debate",
  stages: [
    { id: "debate", pattern: "structured_debate", config: {
      roles: [
        { id: "bull", persona: "Bullish Researcher" },
        { id: "bear", persona: "Bearish Researcher" },
      ],
      evidenceRetrieval: "hybrid",  // graph + vector
      maxRounds: 3,
    }},
  ],
});
```

The utility supports four modes:

| Mode | Behavior |
|---|---|
| `none` | No-op — no evidence retrieval (default) |
| `graph` | Entity/relationship traversal via Cypher queries |
| `vector` | Cosine similarity search on Chunk embeddings |
| `hybrid` | Both graph and vector, merged and deduplicated |

Retrieved evidence is formatted as a text block and injected into the LLM prompt. Evidence items are also merged into the position's evidence array for traceability.

---

## 10. MCP Tools for External Integration

Two MCP tools provide external access to GMPL patterns:

| Tool | Description |
|---|---|
| `gmpl_run_pattern` | Execute any registered GMPL pattern on-demand |
| `gmpl_resolve_outcome` | Resolve a pending decision with real-world outcome data |

External agents (Claude Desktop, Cursor, etc.) can invoke patterns directly:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "gmpl_run_pattern",
    "arguments": {
      "patternId": "structured_debate",
      "query": "Should we invest in renewable energy?",
      "config": {
        "maxRounds": 2,
        "roles": [
          { "id": "bull", "persona": "Optimistic energy analyst" },
          { "id": "bear", "persona": "Skeptical energy analyst" }
        ]
      }
    }
  }
}
```

---

## 11. Run the Example

```bash
# Run tests
bun test src/tests/unit/gmpl/TradingAdapter.test.ts
bun test src/tests/unit/gmpl/TradingRoles.test.ts

# Type-check
bun run typecheck
```

---

## File Structure

```
src/
├── gmpl/
│   ├── retrieveEvidence.ts  # Reusable evidence retrieval utility (graph/vector/hybrid)
│   └── ...                  # PatternRegistry, RoleRegistry, DomainRegistry, etc.
├── domains/
│   └── trading/
│       ├── adapter.ts       # DomainAdapter implementation (incl. authoritySafelist)
│       ├── schemas.ts       # Zod entity schemas
│       ├── roles.ts         # Extended roles via RoleRegistry.extend()
│       └── index.ts         # Barrel export
├── mcp/
│   └── tools/
│       ├── runPattern.ts    # gmpl_run_pattern MCP tool
│       ├── resolveOutcome.ts # gmpl_resolve_outcome MCP tool
│       └── ...              # write, recall, search, manage, entityGet
├── prompts/
│   └── trading/
│       ├── fundamentals.toml
│       ├── technical.toml
│       ├── sentiment.toml
│       ├── debate.toml
│       └── research.toml
├── workflows/
│   └── examples/
│       ├── trading-analysis.json        # GMPL reference: 4-stage trading pipeline
│       ├── healthcare-assistant.json    # GMPL reference: 5-stage clinical assistant
│       └── autonomous-research.json     # GMPL reference: 4-stage research pipeline
└── tests/
    └── unit/gmpl/
        ├── TradingAdapter.test.ts
        └── TradingRoles.test.ts
    └── integration/
        └── composed-workflow-e2e.test.ts  # 13 E2E composition tests
```

---

## Further Reading

- **TradingAgents paper**: `docs/refs/2412.20138v7.pdf` (Xiao et al., arXiv:2412.20138v7)
- **GMPL Architecture**: `docs/ARCHITECTURE.md` §8 (GMPL Layer)
- **GMPL Module Reference**: `docs/modules/gmpl.md` (full module specs + MCP tools + evidence retrieval)
- **API Reference**: `src/gmpl/types.ts` (canonical type definitions)
- **Evidence Retrieval**: `src/gmpl/retrieveEvidence.ts` (utility source)
- **MCP Tools**: `src/mcp/tools/runPattern.ts`, `src/mcp/tools/resolveOutcome.ts`
