# GMPL — Generic Multi-Agent Pattern Library

> **Inspired by**: TradingAgents (arXiv:2412.20138v7), PriHA, HERA  
> **Package**: `src/gmpl/` — public API via `import { PatternRegistry, RoleRegistry, DomainRegistry } from './gmpl/index.js'`  
> **Sub-Workflows**: `src/workflows/sub/patterns/` — structured-debate.json, clarification-pipeline.json, parallel-analysis.json

GMPL is a composable extension layer that provides reusable multi-agent workflow patterns. Instead of implementing domain-specific orchestration logic directly, GMPL defines generic pattern templates (debate, clarification, analysis) that can be specialized per domain through the `DomainRegistry` adapter plugin system.

**Design**: GMPL sits above MemFlow core without modifying it. All 5 GMPL modules are registered in `ModuleRegistry` alongside the 61 existing modules, and all GMPL state flows through the standard `WorkflowData` bus.

---

## Core Infrastructure

### PatternRegistry (`gmpl/PatternRegistry.ts`)

Singleton registry for composable workflow pattern definitions. Each pattern has:
- Zod-validated `configSchema`, `inputContract`, `outputContract`
- Reference to a sub-workflow JSON (`workflowRef`)
- Required roles from `RoleRegistry`
- Observability SSE event types

**Pre-registered patterns**: `structured_debate`, `clarification_pipeline`, `parallel_analysis`

### RoleRegistry (`gmpl/RoleRegistry.ts`)

Library of domain-agnostic agent roles. Supports **role extension** — domain-specific roles inherit from base roles and override fields.

**Pre-registered roles**: `domain_analyst`, `opposing_researcher`, `synthesizer`, `risk_assessor`, `decision_maker`, `critic`, `clarifier`, `outcome_evaluator`

### DomainRegistry (`gmpl/DomainRegistry.ts`)

Registry for domain adapter plugins. Adapters bundle data providers, entity schemas, outcome evaluators, metrics calculators, prompt packs, and seed knowledge into a single registration unit.

---

## Pattern Modules

### DebateModule (Pattern A: Structured Debate)

| | |
|---|---|
| **File** | `gmpl/modules/DebateModule.ts` |
| **Paper** | TradingAgents (arXiv:2412.20138v7) |
| **Input** | `query` |
| **Output** | `debateState`, `consensusReport`, `finalAnswer` |
| **KG Nodes** | `:DebateSession` |

Multi-round structured debate between opposing-view role agents. Each round:
1. All role agents generate positions (stance, evidence, confidence, rebuttal)
2. History from previous rounds is injected for context continuity
3. Termination is checked against the configured strategy

**Config**:
- `roles` — Array of `{id, persona, promptPack}` (minimum 2)
- `maxRounds` — 1–10 (default: 3)
- `termination.type` — `max_rounds` | `consensus_threshold` | `judge_decision`
- `termination.consensusThreshold` — 0–1 (for consensus_threshold mode)
- `evidenceRetrieval` — `hybrid` | `vector` | `graph` | `none` (default: `none`)
- `historyInjection` — boolean (default: `true`)

**Termination Strategies**:
- `max_rounds` — Stop after N rounds, then synthesize
- `consensus_threshold` — Stop when average confidence exceeds threshold
- `judge_decision` — LLM judge evaluates convergence each round

---

### ConsensusJudge (Pattern A helper)

| | |
|---|---|
| **File** | `gmpl/modules/ConsensusJudgeModule.ts` |
| **Input** | `debateState` |
| **Output** | `consensusReport` |

Standalone atomic module for evaluating debate convergence. Produces a `ConsensusReport` with:
- `verdict` — Final assessment
- `convergenceScore` — 0–1
- `keyFindings` — Agreed points
- `dissent` — Remaining disagreements
- `action` — `accept` | `reject` | `continue` | `escalate`

**Config**: `convergenceThreshold` (default: 0.7), `maxContextChars` (default: 4000)

**Fallback**: When LLM evaluation fails, falls back to heuristic convergence scoring based on position confidence values.

---

### MultiTurnClarifier (Pattern B: Clarification Pipeline)

| | |
|---|---|
| **File** | `gmpl/modules/MultiTurnClarifierModule.ts` |
| **Input** | `query`, `userClarificationResponse` (optional), `clarificationState` (optional) |
| **Output** | `clarificationState`, `query` (refined), `expandedQueries`, `clarifications` |

Extends the existing `QueryClarifier` module with **user-facing** clarification questions and stateful multi-turn conversation tracking.

**Config**:
- `maxTurns` — 1–10 (default: 5)
- `complexityGate` — boolean (default: `true`) — skip clarification for clear, specific queries
- `intentSchema` — Optional domain-specific intent classification schema

**Flow**:
1. If `complexityGate` is on and query is clear → pass through unchanged
2. Generate 2–3 user-facing clarification questions
3. Wait for `userClarificationResponse` on next invocation
4. Attempt intent resolution from accumulated conversation
5. On resolution: produce refined query + expanded sub-queries

---

### ParallelDispatcher (Pattern C: Parallel Analysis)

| | |
|---|---|
| **File** | `gmpl/modules/ParallelDispatcherModule.ts` |
| **Input** | `query` |
| **Output** | `analystReports`, `mergedAnalysis`, `finalAnswer` |

Dispatches a query to N parallel analyst agents, collects structured reports, and merges using a configurable strategy. Uses `Promise.allSettled` for fault tolerance — individual analyst failures don't crash the pipeline.

**Config**:
- `analysts` — Array of `{id, role, promptPack}` (minimum 1)
- `mergeStrategy` — `ranked_synthesis` | `weighted_average` | `majority_vote` (default: `ranked_synthesis`)
- `timeout` — Duration string (default: `30s`; supports `ms`, `s`, `m`)

**Merge Strategies**:
- `ranked_synthesis` — Sort reports by confidence, synthesize via LLM
- `weighted_average` — Aggregate with confidence-based weighting
- `majority_vote` — Select recommendations by frequency

---

### OutcomeMemory (Cross-pattern)

| | |
|---|---|
| **File** | `gmpl/modules/OutcomeMemoryModule.ts` |
| **Input** | `pendingDecision` OR `outcomeResolution` OR `outcomeContext="__request__"` |
| **Output** | `pendingDecision` | `outcomeResolution` | `outcomeContext` |
| **KG Nodes** | `:PendingDecision`, `:Decision`, `:Reflection` |
| **KG Edges** | `:IMPROVED_BY`, `:REFERENCES` |

Two-phase outcome memory extending the existing `OutcomeLearnerModule` with a full lifecycle:

**Phase 1 — Log Pending Proposal**:
- After any pattern completes, store result as `:PendingDecision` in KG
- Link to referenced entities via `:REFERENCES` edges

**Phase 2 — Resolve with Outcome**:
- External trigger provides real-world outcome data
- Apply confidence adjustment to linked entities
- LLM generates reflection with lessons learned
- Store `:Decision` + `:Reflection` with `:IMPROVED_BY` edge

**Context Injection**:
- Before new workflows run, pull recent decisions + reflections from KG
- Return augmented context string for injection into prompts

**Config**:
- `twoPhaseEnabled` — boolean (default: `true`)
- `pendingTTL` — Duration string (default: `30d`)
- `reflectionModel` — Optional LLM model override for reflection generation
- `crossDomainLessons` — boolean (default: `false`)
- `pruneResolved.maxEntries` — Max resolved entries to keep (default: 500)
- `pruneResolved.strategy` — `oldest_by_entity` | `lowest_confidence`

---

## Pattern Sub-Workflows

### structured-debate.json

```
DebateModule → ConsensusJudge → FinalSynthesizer
```

3-stage pipeline: multi-round debate with judge evaluation and final synthesis. Default: 2 opposing researchers, 3 max rounds, judge-based termination.

### clarification-pipeline.json

```
MultiTurnClarifier → QueryClarifier → WebSearchAgent → DualSourceFusion → AnswerGenerator → HallucinationValidator → CitationInjector
```

7-stage pipeline extending the existing PriHA `priha-fusion.json` with a user-facing clarification step. Adds the `MultiTurnClarifier` as the first stage for intent disambiguation before the standard retrieval-generation flow.

### parallel-analysis.json

```
ParallelDispatcher → FinalSynthesizer
```

2-stage pipeline: parallel analyst dispatch with ranked synthesis merge. Default: 2 analysts, 30s timeout, ranked_synthesis merge strategy.

---

## Prompt Packs

GMPL prompt templates in `src/prompts/gmpl/`:

| File | Used By | Purpose |
|---|---|---|
| `debate/position.toml` | DebateModule | Position generation with stance, evidence, confidence |
| `debate/rebuttal.toml` | DebateModule | Rebuttal generation addressing opposing views |
| `debate/judge.toml` | ConsensusJudge | Convergence evaluation and verdict |
| `analysis/analyst.toml` | ParallelDispatcher | Structured analysis report generation |
| `analysis/merge.toml` | ParallelDispatcher | Report synthesis and recommendation aggregation |
| `clarification/question.toml` | MultiTurnClarifier | User-facing clarification question generation |
| `clarification/resolve.toml` | MultiTurnClarifier | Intent resolution from conversation history |
| `outcome/reflection.toml` | OutcomeMemory | Reflection and lesson extraction from outcomes |

---

## Type System

All GMPL inter-module data is defined as Zod schemas in `gmpl/types.ts`:

| Schema | Used By | Key Fields |
|---|---|---|
| `DebatePositionSchema` | DebateModule | roleId, stance, evidence, confidence, rebuttal, round |
| `ConsensusReportSchema` | ConsensusJudge | verdict, convergenceScore, keyFindings, dissent, action |
| `DebateStateSchema` | DebateModule | positions[], currentRound, concluded, consensusReport |
| `ClarificationStateSchema` | MultiTurnClarifier | originalQuery, turns[], intentResolved, refinedQuery |
| `AnalystReportSchema` | ParallelDispatcher | analystId, analysis, confidence, sources, recommendations |
| `MergedAnalysisSchema` | ParallelDispatcher | synthesis, reportCount, mergeStrategy, averageConfidence |
| `PendingDecisionSchema` | OutcomeMemory | id, patternId, domainId, content, entityIds, timestamp |
| `DecisionSchema` | OutcomeMemory | pendingId, content, outcome, reflection, resolvedAt |
| `ReflectionSchema` | OutcomeMemory | decisionId, content, lessons, confidenceAdjustment |
