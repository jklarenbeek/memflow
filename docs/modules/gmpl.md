# GMPL — Generic Multi-Agent Pattern Library

> **Inspired by**: TradingAgents (arXiv:2412.20138v7), PriHA, HERA  
> **Package**: `src/gmpl/` — public API via `import { PatternRegistry, RoleRegistry, DomainRegistry, generateWorkflow, GmplError } from './gmpl/index.js'`  
> **Sub-Workflows**: `src/workflows/sub/patterns/` — structured-debate.json, clarification-pipeline.json, parallel-analysis.json, peer-review.json, red-team.json, delphi-panel.json  
> **Domain Example**: `src/domains/trading/` — reference `DomainAdapter` implementation

GMPL is a composable extension layer that provides reusable multi-agent workflow patterns. Instead of implementing domain-specific orchestration logic directly, GMPL defines generic pattern templates (debate, clarification, analysis, peer review, red team, Delphi panel) that can be specialized per domain through the `DomainRegistry` adapter plugin system and composed programmatically via the `PatternComposer` API.

**Design**: GMPL sits above MemFlow core without modifying it. All 8 GMPL modules are registered in `ModuleRegistry` alongside the 61 existing modules, and all GMPL state flows through the standard `WorkflowData` bus.

---

## Core Infrastructure

### PatternRegistry (`gmpl/PatternRegistry.ts`)

Singleton registry for composable workflow pattern definitions. Each pattern has:
- Zod-validated `configSchema`, `inputContract`, `outputContract`
- Reference to a sub-workflow JSON (`workflowRef`)
- Required roles from `RoleRegistry`
- Observability SSE event types

**Pre-registered patterns**: `structured_debate`, `clarification_pipeline`, `parallel_analysis`, `peer_review`, `red_team`, `delphi_panel`

### RoleRegistry (`gmpl/RoleRegistry.ts`)

Library of domain-agnostic agent roles. Supports **role extension** — domain-specific roles inherit from base roles and override fields.

**Pre-registered roles** (11 core): `domain_analyst`, `opposing_researcher`, `synthesizer`, `risk_assessor`, `decision_maker`, `critic`, `clarifier`, `outcome_evaluator`, `fundamentals_analyst`, `technical_analyst`, `sentiment_analyst` + 4 trading-domain extensions: `trading_fundamentals_analyst`, `trading_technical_analyst`, `trading_sentiment_analyst`, `trading_risk_assessor` (15 total)

### DomainRegistry (`gmpl/DomainRegistry.ts`)

Registry for domain adapter plugins. Adapters bundle data providers, entity schemas, outcome evaluators, metrics calculators, prompt packs, and seed knowledge into a single registration unit.

**Pre-registered adapters**: `trading` (reference implementation based on TradingAgents, arXiv:2412.20138v7)

### Error Types (`gmpl/errors.ts`)

7 structured error classes with machine-readable `code`, `context` bag, and `cause` chaining:
- `GmplError` (base), `PatternNotFoundError`, `RoleNotFoundError`, `DomainNotRegisteredError`, `PatternValidationError`, `CompositionError`, `OutcomeResolutionError`, `ConvergenceError`

All registries and the PatternComposer throw these typed errors instead of generic `Error`.

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
2. When `evidenceRetrieval` is not `none`, the `retrieveEvidence()` utility queries the KG/vector store and injects retrieved evidence into the position prompt
3. History from previous rounds is injected for context continuity
4. Termination is checked against the configured strategy

**Config**:
- `roles` — Array of `{id, persona, promptPack}` (minimum 2)
- `maxRounds` — 1–10 (default: 3)
- `termination.type` — `max_rounds` | `consensus_threshold` | `judge_decision`
- `termination.consensusThreshold` — 0–1 (for consensus_threshold mode)
- `evidenceRetrieval` — `hybrid` | `vector` | `graph` | `none` (default: `none`)
- `historyInjection` — boolean (default: `true`)

When evidence retrieval is enabled, retrieved evidence items are merged with LLM-cited evidence for full traceability. On fallback (LLM failure), the position still includes any retrieved evidence.

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

### PeerReviewModule (Pattern D: Peer Review)

| | |
|---|---|
| **File** | `gmpl/modules/PeerReviewModule.ts` |
| **Input** | `query` (draft content) |
| **Output** | `peerReviewState`, `finalAnswer` |

Iterative peer review cycle with N configurable reviewers. Each cycle:
1. All reviewers evaluate the current draft and produce assessments (`accept`, `minor_revision`, `major_revision`, `reject`)
2. If acceptance ratio meets threshold → accept and finalize
3. Otherwise → LLM revises draft incorporating feedback, then next cycle

**Config**:
- `reviewers` — Array of `{id, persona}` (minimum 1)
- `maxCycles` — 1–10 (default: 3)
- `acceptanceThreshold` — 0–1 (default: 0.6) — fraction of reviewers that must accept

---

### RedTeamModule (Pattern E: Red Team)

| | |
|---|---|
| **File** | `gmpl/modules/RedTeamModule.ts` |
| **Input** | `query` (proposal content) |
| **Output** | `redTeamState`, `finalAnswer` |

Adversarial stress-testing with red (attack) and blue (defense) teams. Each round:
1. Red team generates freeform LLM attack seeded by a strategy string for traceability
2. Blue team produces defense with mitigations and confidence
3. Judge evaluates resilience and produces a `ResilienceReport`
4. If resilience score exceeds threshold → conclude; otherwise → next round

**Config**:
- `redTeam` — Array of `{id, persona}` (attackers)
- `blueTeam` — Array of `{id, persona}` (defenders)
- `attackStrategies` — Array of strategy seed strings (default: `["adversarial", "edge_case", "scalability", "security", "consistency"]`)
- `maxRounds` — 1–10 (default: 3)
- `resilienceThreshold` — 0–1 (default: 0.7)

---

### DelphiPanelModule (Pattern F: Delphi Expert Panel)

| | |
|---|---|
| **File** | `gmpl/modules/DelphiPanelModule.ts` |
| **Input** | `query` |
| **Output** | `delphiPanelState`, `finalAnswer` |

Anonymous expert polling with statistical aggregation and convergence detection. Each round:
1. All panelists respond independently with confidence scores
2. Responses are aggregated (mean, median, std_dev, convergence score)
3. If convergence metric is below threshold → converged; otherwise → re-poll with prior-round statistics as context

**Config**:
- `panelists` — Optional array of `{id, persona}` (auto-generated if omitted)
- `panelSize` — Number of panelists when auto-generating (default: 5)
- `maxRounds` — 1–10 (default: 3)
- `convergenceMetric` — `std_dev` | `interquartile_range` | `entropy` | custom (default: `std_dev`)
- `convergenceThreshold` — 0–1 (default: 0.15)
- `anonymize` — boolean (default: `true`)

**Pluggable Convergence**: Custom convergence functions can be registered via `DelphiPanelModule.registerConvergence(name, fn)`. The function receives an array of confidence values and returns a dispersion score (lower = more converged).

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

7-stage pipeline extending the PriHA `priha-fusion.json` with a user-facing clarification step. The `MultiTurnClarifier` serves as the first stage for intent disambiguation before the standard retrieval-generation flow.

### parallel-analysis.json

```
ParallelDispatcher → FinalSynthesizer
```

2-stage pipeline: parallel analyst dispatch with ranked synthesis merge. Default: 2 analysts, 30s timeout, ranked_synthesis merge strategy.

### peer-review.json

```
PeerReviewModule → FinalSynthesizer
```

2-stage pipeline: iterative review cycle with configurable reviewers and acceptance threshold, followed by final synthesis.

### red-team.json

```
RedTeamModule → FinalSynthesizer
```

2-stage pipeline: adversarial red/blue team stress-testing with resilience scoring, followed by final synthesis.

### delphi-panel.json

```
DelphiPanelModule → FinalSynthesizer
```

2-stage pipeline: multi-round anonymous expert polling with convergence detection, followed by final synthesis.


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
| `peer-review/review.toml` | PeerReviewModule | Reviewer assessment generation |
| `peer-review/revision.toml` | PeerReviewModule | Draft revision from review feedback |
| `red-team/attack.toml` | RedTeamModule | Adversarial attack generation |
| `red-team/defense.toml` | RedTeamModule | Defense and mitigation response |
| `red-team/resilience.toml` | RedTeamModule | Resilience scoring and verdict |
| `delphi-panel/poll.toml` | DelphiPanelModule | Expert poll response generation |
| `delphi-panel/aggregate.toml` | DelphiPanelModule | Panel synthesis and aggregation |

All GMPL TOML files include a `[meta]` section with independent versioning (`version`, `pattern`, `role`).

### Trading Domain Prompt Packs

Domain-specific prompt templates in `src/prompts/trading/`:

| File | Used By | Purpose |
|---|---|---|
| `trading/fundamentals.toml` | `trading_fundamentals_analyst` | Earnings, revenue, P/E, ROE, margin analysis |
| `trading/technical.toml` | `trading_technical_analyst` | RSI, MACD, Bollinger Bands, SMA, ADX analysis |
| `trading/sentiment.toml` | `trading_sentiment_analyst` | Social media, news, insider sentiment gauging |
| `trading/debate.toml` | `opposing_researcher` | Bull/bear investment thesis with financial evidence |
| `trading/research.toml` | `trading_risk_assessor` | Risk assessment from risky/neutral/safe perspectives |

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
| `ReviewCycleSchema` | PeerReviewModule | cycleNumber, feedback[], revisedDraft |
| `ReviewFeedbackSchema` | PeerReviewModule | reviewerId, assessment, feedback, issues, strengths |
| `PeerReviewStateSchema` | PeerReviewModule | currentCycle, maxCycles, accepted, acceptanceThreshold, cycles[], currentDraft |
| `AttackSchema` | RedTeamModule | attackerId, attack, strategy, targetWeakness, round |
| `DefenseSchema` | RedTeamModule | defenderId, defense, mitigations, confidence, round |
| `ResilienceReportSchema` | RedTeamModule | resilienceScore, vulnerabilities, strengths, verdict, action |
| `RedTeamStateSchema` | RedTeamModule | currentRound, maxRounds, concluded, attacks[], defenses[], resilienceReport |
| `PanelResponseSchema` | DelphiPanelModule | panelistId, response, confidence, reasoning, round |
| `AggregatedResultSchema` | DelphiPanelModule | mean, median, stdDev, convergenceScore, responses[] |
| `DelphiPanelStateSchema` | DelphiPanelModule | currentRound, maxRounds, converged, convergenceThreshold, rounds[] |
| `PendingDecisionSchema` | OutcomeMemory | id, patternId, domainId, content, entityIds, timestamp |
| `DecisionSchema` | OutcomeMemory | pendingId, content, outcome, reflection, resolvedAt |
| `ReflectionSchema` | OutcomeMemory | decisionId, content, lessons, confidenceAdjustment |
| `PatternCompositionSchema` | PatternComposer | name, domain, orchestration, stages[], memory |
| `PatternStageSchema` | PatternComposer | id, pattern, module, config |

---

## Evidence Retrieval Utility

The `retrieveEvidence()` utility (`gmpl/retrieveEvidence.ts`) provides a unified interface for fetching evidence from the knowledge graph and/or vector store. It is the canonical way for GMPL modules to augment their prompts with evidence.

**Retrieval Modes**:

| Mode | Behavior |
|---|---|
| `none` | No-op — returns empty evidence (default) |
| `graph` | Entity/relationship traversal via Cypher queries with configurable hop depth |
| `vector` | Cosine similarity search on Chunk embeddings (with text-match fallback) |
| `hybrid` | Both graph and vector, merged and deduplicated |

**Key Features**:
- Query term extraction with stop-word filtering
- Content-based deduplication
- Score-based ranking and configurable max items
- Formatted text block output for prompt injection
- Graceful degradation (returns empty evidence on retrieval failure)

**Currently integrated into**: `DebateModule` (via `config.evidenceRetrieval`). Can be consumed by any module with access to `WorkflowContext`.

---

## MCP Tools

Two MCP tools expose GMPL patterns to external agents:

### `gmpl_run_pattern`

Executes a GMPL pattern from `PatternRegistry` against a query. Validates input against the pattern's `inputContract` and config against `configSchema`. Uses `generateWorkflow()` to compose and `WorkflowEngine` to execute.

| Argument | Type | Required | Description |
|---|---|---|---|
| `patternId` | string | ✅ | Pattern ID (e.g., `structured_debate`, `parallel_analysis`) |
| `query` | string | ✅ | Topic/query for the pattern |
| `config` | object | | Pattern-specific config overrides |
| `tenantId` | string | | Tenant ID for domain isolation |

### `gmpl_resolve_outcome`

Resolves a pending decision with a real-world outcome. Optionally uses the domain adapter's `outcomeEvaluator` for richer outcome classification.

| Argument | Type | Required | Description |
|---|---|---|---|
| `pendingId` | string | ✅ | ID of the pending decision |
| `outcome` | string | ✅ | `success`, `failure`, or `partial` |
| `summary` | string | ✅ | Human-readable outcome summary |
| `metrics` | object | | Domain-specific metrics |
| `tenantId` | string | | Tenant ID for domain adapter lookup |
| `evaluatorContext` | object | | Context passed to domain adapter's evaluator |

---

## Reference Composition Workflows

Three reference composition workflows in `src/workflows/examples/` demonstrate multi-pattern pipelines:

| Workflow | Patterns | Stages | Domain |
|---|---|---|---|
| `trading-analysis.json` | `parallel_analysis`, `structured_debate` ×2, `outcome_memory` | 4 | Trading |
| `healthcare-assistant.json` | `clarification_pipeline`, `DualSourceFusion`, `peer_review` | 5 | Healthcare |
| `autonomous-research.json` | `parallel_analysis`, `delphi_panel`, `red_team`, `outcome_memory` | 4 | Research |

These workflows are validated by the `composed-workflow-e2e.test.ts` integration test suite (13 tests covering structure, wiring, and stage uniqueness).
