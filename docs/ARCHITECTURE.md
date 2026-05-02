# MemFlow Architecture

> Self-Improving RAG & Lifelong Memory Workflow Engine — Composable Atomic Modules with Sub-Workflow Nesting

---

## Design Philosophy

MemFlow is **composable, typed, and self-improving**:

- Every research paper capability is decomposed into **atomic modules** — small, focused units that do exactly one thing.
- Atomic modules are composed into **sub-workflows** — JSON-described DAGs that replicate paper-aligned pipelines.
- Sub-workflows are callable from parent workflows via the **`SubWorkflow`** engine module, enabling workflows-within-workflows with shared context.
- Modules communicate through a **typed shared data bus** (`WorkflowData`), not `Record<string, any>`.
- The **WorkflowEngine** reads a JSON file and executes stages with retry, parallel branches, conditional routing, and optional learning loops.
- **WorkflowContext** provides dependency injection — shared Memgraph client, StateStore, cached LLM/Embedding providers with per-module overrides, and Winston structured logging.
- **StateStore** provides Memgraph-backed persistent state with in-memory LRU cache for crash recovery of long-running workflows.
- **Memgraph + MAGE** is the persistence layer for graphs, vectors, memory units, and module state.
- S2Chunker extends LangChain's **real `TextSplitter`** class — drop-in compatible with any LCEL pipeline.
- All LLM prompts are externalised as **TOML files** (`src/prompts/`), with configurable temperature, token limits, and `{{variable}}` template rendering.
- Original monolithic modules remain as **backward-compatible wrappers** — existing workflows continue to work unchanged.

## High-Level Architecture

```mermaid
graph TD
    JSON["Workflow JSON"] --> WE["WorkflowEngine"]
    WE --> CTX["WorkflowContext (DI)"]
    CTX --> MG["MemgraphClient"]
    CTX --> SS["StateStore"]
    CTX --> LLM["LLM Provider"]
    CTX --> EMB["Embedding Provider"]
    CTX --> LOG["Winston Logger"]
    
    WE --> MR["ModuleRegistry (66 modules)"]
    WE --> EE["WorkflowEventEmitter"]
    EE --> METRICS["Prometheus Metrics"]
    EE --> SSE["SSE Endpoint"]
    
    MR --> SUB["SubWorkflow"]
    
    subgraph "Atomic Modules"
        MR --> M_MEM["Memory (16 atomic)"]
        MR --> M_AGT["Agents (7 atomic)"]
        MR --> M_RET["Retrieval (8 atomic)"]
        MR --> M_GRF["Graph (5 atomic)"]
        MR --> M_GEN["Generation (6 atomic)"]
    end
    
    subgraph "Composite Wrappers"
        MR --> SM["SimpleMem"]
        MR --> LM["LightMem"]
        MR --> STM["StructMem"]
        MR --> LR["LightRAGRetriever"]
        MR --> HERA["HERAOrchestrator"]
        MR --> PH["PriHAFusion"]
        MR --> MGMOD["MemgraphGraph"]
    end
    
    subgraph "GMPL Pattern Layer"
        MR --> DEBATE["DebateModule"]
        MR --> JUDGE["ConsensusJudge"]
        MR --> CLARIFY["MultiTurnClarifier"]
        MR --> PARALLEL["ParallelDispatcher"]
        MR --> OUTCOME["OutcomeMemory"]
        GMPL_PR["PatternRegistry"] --> DEBATE
        GMPL_PR --> CLARIFY
        GMPL_PR --> PARALLEL
        GMPL_RR["RoleRegistry"] --> DEBATE
        GMPL_RR --> PARALLEL
        GMPL_DR["DomainRegistry"] -.-> GMPL_PR
    end
    
    WE -->|"learning loop"| WE
    WE --> API["Hono HTTP Server"]
    API --> MCP["MCP Server"]
    API --> ACP["ACP Server"]
    API --> REST["REST API /api/v1"]
    
    SS -->|"flush/restore"| MG
```

## Core Runtime

### WorkflowEngine (`core/WorkflowEngine.ts`)
1. Parse JSON config → validate with Zod
2. `initialize()` → create WorkflowContext, **validate all module configs** (fail-fast), resolve modules, call `init()`
3. `initializeWithContext(parentCtx)` → reuse existing context (for sub-workflows), **validate configs**
4. `run()` → execute DAG with retry, trace, and optional learning iterations
5. `runStream()` → execute DAG with SSE event emission via `WorkflowEventEmitter`
6. `shutdown()` → call `shutdown()` on all modules and context

Features:
- **Parallel DAG execution**: when `next` is an array, branches execute concurrently via `Promise.allSettled`. The `dependsOn` field gates execution until all listed dependencies complete. `maxConcurrency` in `globalConfig` limits parallel width.
- **Configurable conditional routing**: `next` can be `{ "metric>threshold": "stageId", "default": "fallback" }` with operators `>`, `>=`, `<`, `<=`, `==`, `!=`. Bare metric names default to `> 0.5` for backward compatibility.
- **Sub-workflow nesting**: stages with `module: "SubWorkflow"` instantiate a child WorkflowEngine with shared context, controlled by `workflow`/`workflowRef`, `inputMap`, and `outputMap`.
- **Stage config overrides**: the `_stageConfigs` mechanism allows composite wrappers to pass per-stage configuration overrides to child engines via `setStageConfigOverrides()`. Overrides are merged consistently across all five engine lifecycle paths: `initialize()`, `initializeWithContext()`, `executeStage()`, `executeStageStreaming()`, and `validateModuleConfigs()`.
- **Config validation at load time**: `validateModuleConfigs()` resolves every module and calls `getConfigSchema().parse()` during `initialize()`, surfacing all Zod validation errors as a single `WorkflowConfigError` before execution begins.
- **Current stage tracking**: `state.currentStage` is updated before each stage executes, ensuring error events report the correct failing stage.
- Exponential backoff retry per stage
- Learning loop with composite scoring
- State export as JSON

### WorkflowEventEmitter (`core/WorkflowEventEmitter.ts`)
Typed wrapper around Node.js's native `EventEmitter` providing the event backbone for SSE streaming and Prometheus metrics:
- Type-safe `on()` / `once()` / `off()` for each `StreamEvent` discriminated union type
- Wildcard `*` channel that receives all events for pass-through consumers
- `toAsyncGenerator()` bridge for backward-compatible AsyncGenerator consumption
- Buffered queue pattern with backpressure handling
- AbortSignal support for client disconnect cleanup

### WorkflowContext (`core/WorkflowContext.ts`)
DI container holding all shared runtime resources:
- **MemgraphClient** — singleton, parameterised Cypher only
- **StateStore** — Memgraph-backed persistent state with in-memory LRU cache
- **LLM providers** — cached by `provider:model` key, per-module override
- **Embedding providers** — same caching strategy
- **Winston logger** — structured JSON logging
- **Trace accumulator** — per-stage timing and I/O summaries
- **Sub-workflow depth tracker** — prevents infinite recursion (default max 5)

### MemgraphClient (`providers/MemgraphClient.ts`)
Singleton Cypher query client with parameterised-only bindings:
- **`query(cypher, params)`** — single parameterised query execution
- **`batchQuery(cypher, items, additionalParams?)`** — `UNWIND $items AS item` batch helper that reduces N round-trips to 1
- **`withTransaction(fn, mode)`** — managed read/write transactions
- **`getQueryCount()` / `resetQueryCount()`** — telemetry counters for per-stage Cypher query tracking
- **Identifier validation** — strict `^[A-Za-z_][A-Za-z0-9_]{0,63}$` allowlist for labels/properties

### StateStore (`core/StateStore.ts`)
Persistent module state for stateful components (LightMem tiers, HERA experience library):
- **In-memory LRU cache** for zero-latency hot reads within a run
- **Memgraph persistence** via `:ModuleState` nodes for crash recovery
- **Auto-flush** every 5s for dirty entries
- **`restore()`** rehydrates all state from Memgraph on workflow resume
- **Scoped** by `workflowId + moduleKey` for isolation

### ModuleRegistry (`core/ModuleRegistry.ts`)
Singleton factory with lazy dynamic imports, instance caching by `module::stageId`, `clearInstances()` for validation cleanup, and runtime plugin registration. Registers **66 built-in modules**: 7 composite wrappers (thin delegation layers), 42 atomic pipeline modules, 5 GMPL pattern modules, 3 standalone modules, 2 provider modules, 2 core modules (SubWorkflow + AutonomousLoop), 4 advanced modules (AgentContext, OutcomeLearner, Crystallizer, Contradiction), and 1 query module.

### SubWorkflowModule (`modules/core/SubWorkflowModule.ts`)
Enables workflows-within-workflows:
- Loads child workflow from `workflow` (inline JSON) or `workflowRef` (file path)
- Maps data between parent and child via `inputMap`/`outputMap`
- Reads `_stageConfigs` from parent input data and applies overrides to child engine before initialization
- Shares parent's WorkflowContext (no duplicate connections)
- Recursion depth guard (default max 5)

### AutonomousLoopModule (`modules/core/AutonomousLoopModule.ts`)
Meta-module that wraps any sub-workflow in an iterative diagnosis → mutation → re-execution loop (OMNI-SIMPLEMEM §3). Uses `ModuleRegistry.resolve()` to instantiate child workflows (decoupled from direct `SubWorkflowModule` import).

## Module Deep Dive

> **Full per-module reference** (input/output fingerprints, config schemas, behavioral descriptions, paper traceability): **[MODULES.md](MODULES.md)**

### Pipeline Architecture Summary

| Pipeline | Atomic Modules | Sub-Workflow | Paper |
|---|---|---|---|
| **SimpleMem Write** | SlidingWindow → DensityGate → FactExtractor → SemanticSynthesis → StructuredIndex | `simplemem-pipeline.json` | SimpleMem §2 |
| **SimpleMem Read** | IntentAwarePlanner → [VectorSearch ∥ KeywordSearch ∥ SymbolicSearch] → ResultRanker | `simplemem-retrieval.json` | SimpleMem §2.3 |
| **LightMem** | PreCompression → SensoryBuffer → [cond] → NoveltyGate → TopicSegmenter → STMBuffer → SleepConsolidation | `lightmem-pipeline.json` | LightMem §3.1–3.3 |
| **StructMem** | DualPerspective → CrossEventConsolidation → GraphPersist | `structmem-pipeline.json` | StructMem §3 |
| **HERA Agents** | PlanGenerator → TrajectoryExecutor → RewardComputer → ExperienceReflector → [RoPEEvolver] → [TopologyMutator] → FinalSynthesizer | `hera-orchestration.json` | HERA |
| **Hybrid Retrieval** | IntentClassifier → [VectorSearch ∥ GraphSearch ∥ KeywordSearch] → ResultRanker | `hybrid-retrieval.json` | LightRAG |
| **Graph Indexing** | ChunkIngestor → EntityExtractor → EntityDeduplicator → EntityProfiler → CommunityDetector | `graph-indexing.json` | LightRAG §3.1 |
| **PriHA Generation** | QueryClarifier → AnswerGenerator → HallucinationValidator → CitationInjector | `priha-fusion.json` | PriHA |
| **GMPL: Structured Debate** | DebateModule → ConsensusJudge → FinalSynthesizer | `patterns/structured-debate.json` | TradingAgents |
| **GMPL: Clarification Pipeline** | MultiTurnClarifier → QueryClarifier → WebSearch → DualSourceFusion → Generate → Validate → Cite | `patterns/clarification-pipeline.json` | PriHA + GMPL |
| **GMPL: Parallel Analysis** | ParallelDispatcher → FinalSynthesizer | `patterns/parallel-analysis.json` | TradingAgents |

### Key Algorithmic Behaviors

- **SleepConsolidation**: Per-entry update queues `Q(eᵢ) = Topk({eⱼ, sim(vᵢ, vⱼ)} | tⱼ ≥ tᵢ)` with parallel `Promise.allSettled` execution (LightMem §3.3). Configurable `similarityFunction`.
- **RoPEEvolver**: Prompt consolidation via projection ΠC — merges, not overwrites. Integrates per-agent failure buffers from `HERAOrchestrator` (HERA §3.4)
- **KeywordSearch**: Dual mode — basic Memgraph text index or MAGE BM25 with configurable k1/b parameters
- **CommunityDetector**: Louvain (`community_detection.get()`) or Leiden (`leiden_community_detection.get()`) with LLM community summaries persisted as `:Community` nodes. Uses `batchQuery()` for N→1 label writes.
- **CrossEventConsolidation**: Time-window–bounded seed retrieval with aggregated centroid query (StructMem §3.2). Fallback: pairwise similarity binding when LLM returns zero connections. Configurable `similarityFunction`.
- **EntityDeduplicator**: `checkExistingGraph` mode queries Memgraph before dedup for true incremental graph updates
- **CitationInjector**: Persists `:Citation` nodes with `:CITES` edges for traceable source attribution. Uses `batchQuery()` UNWIND for N+1→2 round-trip reduction.
- **TopicSegmenter**: Hybrid B1∩B2 boundary detection with configurable similarity function (`cosine`, `euclidean`, `dotProduct`). Derives `topicLabel` for each segment.
- **GraphSearch**: Entity-centric graph traversal. Community-aware mode: when `communityScope: true` and `searchScope` is high-level, queries `:Community` summaries for theme-based retrieval.
- **DualSourceFusion**: Dual-source context fusion (CLocal + CWeb) with source authority scoring, temporal freshness weighting, and budget-gated segment ranking.

### Standalone Modules

- **S2Chunker**: Real spectral clustering on spatial+semantic affinity (extends LangChain `TextSplitter`). Companion: `MarkdownSpatialParser`.
- **QueryTranslator**: HyDE, Multi-Query, Step-Back, Query Rewriting, Intent Clarification — real LLM calls with string-template fallbacks.
- **ParentChildChunker**: Two-tier chunking (small children for precision, large parents for context) with `:BELONGS_TO` graph edges. Uses `batchQuery()` for N→2 batch persistence.
- **AutonomousLoop**: Meta-module wrapping any sub-workflow in an iterative diagnosis → mutation → re-execution loop (OMNI-SIMPLEMEM §3). Decoupled from `SubWorkflowModule` — uses `ModuleRegistry.resolve()`.

## Observability

### Prometheus Metrics (`server/metrics.ts`)

The `wireEngineMetrics()` function subscribes to a `WorkflowEventEmitter` and records:

| Metric | Type | Labels |
|---|---|---|
| `stage_duration_seconds` | Histogram | `module`, `stage_id` |
| `stage_errors_total` | Counter | `module`, `will_retry` |
| `workflow_runs_total` | Counter | `workflow_name`, `status` |
| `workflow_duration_seconds` | Histogram | `workflow_name` |
| `active_workflows` | Gauge | — |

The metrics subsystem includes a TTL sweep that clears stale workflow tracking entries older than 1 hour, preventing memory accumulation from abnormally terminated workflows.

Metrics are served at `GET /metrics` in Prometheus exposition format. Collection is enabled by default and can be disabled via `enableMetrics: false` in `GlobalConfig`.

### Grafana Dashboard

A pre-provisioned Grafana dashboard (`docker/grafana/dashboard.json`) provides 5 panels: Stage Latency (p99), Stage Error Rate (5m), Workflow Throughput (5m), Active Workflows, and Workflow Duration (p99).

### SSE Streaming

The `WorkflowEventEmitter` emits 7 discriminated event types:

| Event | When | Key Fields |
|---|---|---|
| `workflow:start` | Workflow begins | `workflowId`, `stages[]` |
| `stage:start` | Stage about to execute | `stageId`, `module`, `progress` |
| `stage:progress` | LLM token generated | `stageId`, `token`, `tokenIndex` |
| `stage:complete` | Stage finished | `stageId`, `durationMs`, `preview` |
| `stage:error` | Stage failed | `stageId`, `error`, `willRetry` |
| `workflow:complete` | Workflow finished | `totalDurationMs`, `finalAnswer` |
| `workflow:error` | Workflow-level failure | `error`, `stage` |

Modules opt into token-level streaming by implementing `processStream()` (currently: `AnswerGenerator`, `FinalSynthesizer`).

## Data Model in Memgraph

- **:Chunk** — S2 output (text, embedding, source)
- **:MemoryUnit** — atomic facts/events/summaries (content, embedding, type, timestamp, confidence)
- **:Entity** — LLM-extracted entities with type, description, profileSummary, keyThemes, `communityId`
- **:Community** — Community summaries from MAGE detection (id, summary, nodeCount, members)
- **:Element** — raw layout elements from document parser
- **:ParentChunk** — Large context chunks for PriHA parent-child retrieval
- **:ChildChunk** — Small precision chunks for PriHA parent-child retrieval
- **:Answer** — Generated answers for citation tracking
- **:Citation** — Traceable source URLs with title, accessedAt, verified status
- **:ModuleState** — persistent module state (workflowId, moduleKey, value JSON, updatedAt)
- **:DebateSession** — GMPL debate sessions (id, query, rounds, verdict, convergenceScore, timestamp)
- **:PendingDecision** — GMPL two-phase outcome memory: unresolved decision proposals
- **:Decision** — GMPL resolved decisions with outcome data
- **:Reflection** — GMPL LLM-generated reflections on resolved outcomes
- **Edges**: `SPATIAL_NEAR`, `MEMORY_RELATION`, `MENTIONS`, `RELATES_TO` (typed relationships with description + keywords), `BELONGS_TO` (child→parent chunks), `CITES` (answer→citation), `IMPROVED_BY` (decision→reflection), `REFERENCES` (decision→entity)
- **Indexes**: Vector on `Chunk.embedding`, `MemoryUnit.embedding`; scalar on `PendingDecision.id`, `Decision.pendingId`, `Reflection.decisionId`

## HTTP API (Hono)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Service health + dependency checks (Memgraph, Ollama, Tavily) |
| `/modules` | GET | List available modules |
| `/metrics` | GET | Prometheus metrics endpoint |
| `/workflow/run` | POST | Execute workflow from JSON config + input with aggregated telemetry |
| `/workflow/run/stream` | POST | Execute workflow with SSE streaming |
| `/mcp` | POST | MCP server (5 tools: write, recall, search, manage, entity_get) |
| `/acp` | POST/GET | ACP server (request/response + SSE) |
| `/api/v1/*` | CRUD | REST API for memories, entities, search, recall, graph stats |
| `/prompts/validate` | GET | Validate TOML prompt references |
| `/prompts/reload` | POST | Invalidate TOML prompt cache |

## Type Safety

The `WorkflowData` interface provides typed fields for all inter-module data:

| Stage | Fields |
|---|---|
| Query | `query`, `expandedQueries`, `clarifications` |
| Chunking | `documents`, `chunks`, `markdown` |
| Embedding | `embeddings` |
| Memory pipeline | `memoryUnits`, `windowedChunks`, `filteredChunks`, `topicSegments` |
| Graph | `graphContext`, `entities`, `relationships` |
| Retrieval | `retrievalResult`, `candidates`, `searchScope` |
| Agents | `agentResult`, `agentPlan`, `trajectory`, `insights` |
| Generation | `finalAnswer`, `sources`, `confidence`, `fusedContext` |
| GMPL: Debate | `debateState`, `consensusReport` |
| GMPL: Clarification | `clarificationState`, `userClarificationResponse` |
| GMPL: Analysis | `analystReports`, `mergedAnalysis` |
| GMPL: Outcome | `pendingDecision`, `outcomeResolution`, `outcomeContext` |
| Telemetry | `metrics.tokenUsage`, `metrics.memgraphQueries`, `metrics.embeddingCalls` |
| Meta | `metrics`, `[key: string]: unknown` (escape hatch) |

## Error Handling

7 typed error classes: `MemFlowError`, `WorkflowStageError`, `WorkflowConfigError`, `WorkflowDAGError`, `ModuleNotFoundError`, `ProviderError`, `MemgraphError`.

All module error boundaries use structured logging instead of bare `catch {}` blocks. Errors include the originating module name, error message, and relevant context (node IDs, query details, batch sizes) for actionable debugging.

## Security & Production Notes

- No external code execution in workflow JSON
- All Cypher query values use parameterised bindings (no string interpolation of user data); label/property identifiers are validated against a strict `^[A-Za-z_][A-Za-z0-9_]{0,63}$` allowlist before interpolation (required because Cypher does not support parameterised labels). DDL statements (CREATE INDEX) also interpolate `dimensions` which is validated as a safe positive integer (1–65536) via `assertSafeDimension()`.
- API keys via env only
- Memgraph auth + network isolation recommended in prod
- CORS middleware on HTTP server
- **Bun-first runtime**: Bun is the primary and recommended runtime. Server auto-detects Bun vs Node.js via `globalThis.Bun`. Bun uses native `Bun.serve()`, Node.js falls back to `@hono/node-server` (listed in `optionalDependencies`) with raw `node:http` as a last resort.
- **Environment**: Bun auto-loads `.env` files — no `dotenv` dependency needed. No `ts-node` required — Bun runs `.ts` natively.
- **Docker**: Multi-stage build with `oven/bun:1` builder and `memgraph/memgraph-mage` runtime. Bun runs TypeScript directly — no `tsc` build step in the container.

## Prompt System (TOML)

All LLM prompts are externalised in `src/prompts/` as TOML files:

```
src/prompts/
  simplemem/     extraction.toml, density_gating.toml, synthesis.toml, intent_aware_planning.toml
  lightmem/      consolidation.toml, pre_compression.toml
  structmem/     dual_perspective.toml, consolidation_synthesis.toml
  retrieval/     intent_inference.toml
  hera/          plan_generation.toml, reflection.toml, reflection_single.toml, synthesis.toml, rope_evolution.toml, topology_mutation.toml
  hera/roles/    13 role-specific agent prompts
  priha/         clarification.toml, generation.toml, refinement.toml, validation.toml
  query/         hyde.toml, multi_query.toml, step_back.toml, query_rewriting.toml, intent_clarification.toml
  graph/         entity_extraction.toml, entity_profiling.toml, deduplication.toml
```

Each TOML file contains `[meta]` (name, version), `[config]` (temperature, max_tokens, custom knobs), and `[[messages]]` with `{{variable}}` template placeholders. Loaded via `src/utils/promptLoader.ts`.

### Startup Validation

`WorkflowContext.create()` calls `validateAllPrompts()` which checks all 25+ known TOML prompt references against the file system. Missing or malformed prompts are logged as warnings for fail-fast error surfacing.

### Hot-Reload

`startPromptWatcher()` monitors `src/prompts/` via `fs.watch` with a 300ms debounce. When a TOML file changes on disk, the cached version is automatically invalidated. The `POST /prompts/reload` endpoint provides manual cache invalidation for CI/CD scenarios.

## GMPL — Generic Multi-Agent Pattern Library

GMPL is an extension layer that provides composable, reusable multi-agent workflow patterns. It adds three registries and five modules without modifying existing MemFlow core code.

### Registries

| Registry | Purpose | Pre-registered |
|---|---|---|
| `PatternRegistry` | Composable workflow pattern definitions with Zod-validated input/output contracts | 3 patterns (Structured Debate, Clarification Pipeline, Parallel Analysis) |
| `RoleRegistry` | Domain-agnostic agent role library with extension support | 8 roles (domain_analyst, opposing_researcher, synthesizer, risk_assessor, decision_maker, critic, clarifier, outcome_evaluator) |
| `DomainRegistry` | Domain adapter plugins (data providers, evaluators, prompt packs, entity schemas) | None (populated at runtime) |

### Pattern Modules

| Module | Pattern | Description |
|---|---|---|
| `DebateModule` | Structured Debate | Multi-round opposing-view debate with evidence, history injection, and 3 termination strategies (max rounds, consensus threshold, judge decision) |
| `ConsensusJudge` | Structured Debate | Atomic debate judge that evaluates convergence and produces a ConsensusReport |
| `MultiTurnClarifier` | Clarification Pipeline | User-facing clarification with stateful conversation history and complexity gate |
| `ParallelDispatcher` | Parallel Analysis | Dispatches to N analyst agents in parallel with timeout and configurable merge strategies |
| `OutcomeMemory` | Cross-pattern | Two-phase (pending → resolution) outcome memory with LLM reflections and KG persistence |

### Pattern Sub-Workflows

Three GMPL pattern sub-workflows in `src/workflows/sub/patterns/`:

| File | Pipeline | Inspired By |
|---|---|---|
| `structured-debate.json` | DebateModule → ConsensusJudge → FinalSynthesizer | TradingAgents (arXiv:2412.20138v7) |
| `clarification-pipeline.json` | MultiTurnClarifier → QueryClarifier → WebSearch → DualSourceFusion → Generate → Validate → Cite | PriHA + GMPL |
| `parallel-analysis.json` | ParallelDispatcher → FinalSynthesizer | TradingAgents |

### Prompt Packs

GMPL prompt templates in `src/prompts/gmpl/`:

```
src/prompts/gmpl/
  debate/        position.toml, rebuttal.toml, judge.toml
  analysis/      analyst.toml, merge.toml
  clarification/ question.toml, resolve.toml
  outcome/       reflection.toml
```

## Workflow Versioning

Workflow JSON configs include a `"version"` field (defaults to `"1.0"` for backward compatibility). The engine validates versions during construction:

| Version | Status | Behavior |
|---|---|---|
| `1.0`, `1.1`, `2.0` | Current | Accepted silently |
| `0.1`, `0.2` | Deprecated | Accepted with warning — migration recommended |
| Other | Unsupported | Rejected with `WorkflowConfigError` |

## Sub-Workflow System

Sub-workflows enable workflows-within-workflows. Any stage can delegate to a child workflow via the `SubWorkflow` module:

```json
{
  "id": "retrieve",
  "module": "SubWorkflow",
  "workflowRef": "src/workflows/sub/hybrid-retrieval.json",
  "inputMap": { "query": "query" },
  "outputMap": { "retrievalResult": "retrievalResult" },
  "next": "generate"
}
```

Pre-built sub-workflows in `src/workflows/sub/`:

| File | Stages | Key Feature |
|---|---|---|
| `simplemem-pipeline.json` | Window → Gate → Extract → Synthesize → Index | Full SimpleMem §2 write path |
| `simplemem-retrieval.json` | Plan → [Sem ∥ Lex ∥ Sym] → Rank | SimpleMem §2.3 multi-view retrieval |
| `lightmem-pipeline.json` | PreCompress → SensoryBuffer → [cond] → Novelty → Segment → STMBuffer → Consolidate | Full LightMem 3-tier (Light₁+Light₂+Light₃) |
| `structmem-pipeline.json` | DualPersp → Consolidate → Persist | Cbuf→seed→LLM synthesis |
| `hera-orchestration.json` | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize | Conditional GRPO branches |
| `hybrid-retrieval.json` | Intent → [Vector ∥ Graph ∥ Keyword] → Rank | 3-way parallel fan-out |
| `graph-indexing.json` | Ingest → Extract → Dedup → Profile → Community | LightRAG §3.1 |
| `priha-fusion.json` | Clarify → Generate → Validate → Cite | Full PriHA pipeline |

## Workflow Examples

Three top-level example workflows in `src/workflows/examples/`:
- `rag-memory-pipeline.json` — Full 10-stage pipeline: translate → parse → chunk → embed → graph → SimpleMem → LightMem → StructMem → retrieve → fuse
- `quick-qa.json` — Minimal 4-stage QA: translate → embed → retrieve → fuse
- `multi-agent-research.json` — Advanced: parallel retrieval branches → HERA with learning + RoPE + topology mutation

## File Structure

```
src/
  core/
    WorkflowEngine.ts         — DAG executor with parallel, retry, learning loops, sub-workflow support
    WorkflowContext.ts         — DI container (Memgraph, LLM, Embeddings, StateStore, Logger)
    WorkflowEventEmitter.ts    — Typed event system for streaming and Prometheus metrics
    ModuleRegistry.ts          — Lazy-loading singleton with 66 registered modules
    StateStore.ts              — Memgraph-backed persistent state with LRU cache
    types.ts                   — All interfaces (WorkflowData, BaseModule, StreamEvent, etc.)
    errors.ts                  — 7 typed error classes
  gmpl/
    types.ts                   — GMPL Zod schemas and TypeScript interfaces
    PatternRegistry.ts         — Composable workflow pattern registry (3 built-in patterns)
    RoleRegistry.ts            — Agent role library (8 core roles) with extension support
    DomainRegistry.ts          — Domain adapter plugin registry
    index.ts                   — Public API barrel export
    modules/
      DebateModule.ts          — Structured multi-round debate (Pattern A)
      ConsensusJudgeModule.ts  — Debate convergence evaluation (Pattern A helper)
      MultiTurnClarifierModule.ts — User-facing clarification (Pattern B)
      ParallelDispatcherModule.ts — Parallel analyst dispatch (Pattern C)
      OutcomeMemoryModule.ts   — Two-phase outcome memory
  modules/
    core/                      SubWorkflowModule, AutonomousLoopModule, AgentContextModule
    chunking/                  S2ChunkerModule, MarkdownSpatialParserModule, ParentChildChunkerModule
    memory/                    SimpleMemModule, LightMemModule, StructMemModule,
                               SlidingWindowModule, DensityGateModule, FactExtractorModule,
                               SemanticSynthesisModule, NoveltyGateModule, TopicSegmenterModule,
                               SleepConsolidationModule, DualPerspectiveModule,
                               CrossEventConsolidationModule, GraphPersistModule,
                               StructuredIndexModule, PreCompressionModule, SensoryBufferModule,
                               STMBufferModule, IntentAwarePlannerModule, AttentionScoreModule,
                               OutcomeLearnerModule, CrystallizerModule, ContradictionModule
    agents/                    HERAOrchestratorModule, PlanGeneratorModule, TrajectoryExecutorModule,
                               RewardComputerModule, ExperienceReflectorModule,
                               RoPEEvolverModule, TopologyMutatorModule, FinalSynthesizerModule
    retrieval/                 LightRAGRetrieverModule, IntentClassifierModule, VectorSearchModule,
                               GraphSearchModule, KeywordSearchModule, ResultRankerModule,
                               SymbolicSearchModule, SetUnionMergerModule, DualLevelRouterModule
    graph/                     MemgraphGraphModule, ChunkIngestorModule, EntityExtractorModule,
                               EntityDeduplicatorModule, EntityProfilerModule, CommunityDetectorModule
    generation/                PriHAFusionModule, DualSourceFusionModule, QueryClarifierModule,
                               AnswerGeneratorModule, HallucinationValidatorModule,
                               CitationInjectorModule, WebSearchAgentModule
    query/                     QueryTranslatorModule
    providers/                 EmbedderModule, LLMProviderModule
  mcp/                         MCP server implementation (5 tools)
  acp/                         ACP server implementation
  workflows/
    examples/                  rag-memory-pipeline.json, quick-qa.json, multi-agent-research.json
    sub/                       simplemem-pipeline.json, simplemem-retrieval.json,
                               lightmem-pipeline.json, structmem-pipeline.json,
                               hera-orchestration.json, hybrid-retrieval.json, graph-indexing.json,
                               priha-fusion.json
    sub/patterns/              structured-debate.json, clarification-pipeline.json,
                               parallel-analysis.json
    service/                   ingest.json, recall.json, search.json (REST API backing workflows)
  prompts/                     TOML prompt templates (see Prompt System section)
    gmpl/                      debate/, analysis/, clarification/, outcome/ (GMPL prompts)
  providers/                   LLMProvider.ts, EmbeddingProvider.ts, MemgraphClient.ts
  server/                      Hono HTTP server, metrics.ts, mcp.ts, acp.ts, api.ts
  utils/                       promptLoader.ts, similarity.ts, tokens.ts
  tests/
    unit/                      22 unit test files (including 8 GMPL pattern tests)
    integration/               3 integration test files (full-pipeline, streaming-e2e, sub-workflow-e2e)
    helpers/                   Shared mock factory (mocks.ts)
```

---

*Every module is traceable to a specific paper. See [PAPERS.md](docs/PAPERS.md) for the full reference list.*