# MemFlow — Improvement Roadmap

> Actionable improvements derived from architectural analysis, paper alignment audit, and codebase review.

## Completion Tracker

| # | Improvement | Status | Version |
|---|---|---|---|
| 5 | Batch Memgraph operations | ✅ Completed | v0.3.0 |
| 6 | Proper error boundaries | ✅ Completed | v0.3.0 |
| 7 | MemoryUnit field propagation | ✅ Completed | v0.3.0 |
| 8 | TOML prompt coverage | ✅ Completed | v0.4.0 |
| 9 | Streaming support (SSE) | ✅ Completed | v0.4.0 |
| 10 | Module-level telemetry | ✅ Completed | v0.3.0 |
| 11 | Config validation at load time | ✅ Completed | v0.3.0 |
| 12 | Decouple AutonomousLoop | ✅ Completed | v0.3.0 |
| 13 | Community-aware graph search | ✅ Completed | v0.4.0 |
| 14 | Configurable similarity function | ✅ Completed | v0.3.0 + v0.4.0 |
| 15 | Hot-reload for TOML prompts | ✅ Completed | v0.4.0 |
| 16 | Workflow versioning and migration | ✅ Completed | v0.4.0 |

> **13 of 22 items completed** (4 P0 critical, 2 P1 high remain open)

---

## Priority Legend

| Priority | Meaning |
|---|---|
| 🔴 P0 | Critical — blocking production readiness or correctness |
| 🟡 P1 | High — significant quality or performance improvement |
| 🟢 P2 | Medium — nice-to-have, developer experience, maintainability |
| ⚪ P3 | Low — future exploration, research alignment |

---

## 🔴 P0 — Critical

### 1. Install dependencies and validate build

**Problem**: `node_modules/` is absent — no TypeScript compilation has been verified against the current codebase.

**Action**:
- Run `bun install` and `bun run build` (or `tsc --noEmit`)
- Fix any type errors introduced by MemoryUnit enrichment and new module registrations
- Add a CI step that runs `tsc --noEmit` on every commit

### 2. WebSearchAgent is a stub — PriHA pipeline is incomplete

**Problem**: The `WebSearchAgent` returns empty results, which means the PriHA Reconciler (CLocal + CWeb fusion) cannot be implemented. The PriHA pipeline currently runs as local-only.

**Action**:
- Integrate a search API provider (Tavily, Brave Search, or SerpAPI)
- Implement the ReAct-style iterative search loop from PriHA §3.3
- Build the PriHA Reconciler module: source priority rules, temporal freshness scoring, conflict resolution
- Add URL safelist validation for crawled content

### 3. Missing sub-workflow JSON files

**Problem**: `simplemem-retrieval.json` is referenced in documentation but may not exist on disk yet.

**Action**:
- Verify all 8 sub-workflow JSONs exist in `src/workflows/sub/`
- Create any missing files with correct stage definitions, `inputMap`, `outputMap`, and `next` routing
- Validate each JSON against the `WorkflowEngine` parser

### 4. End-to-end integration tests

**Problem**: No integration tests verify that a complete sub-workflow pipeline (e.g., `simplemem-pipeline.json`) produces correct outputs when modules are chained.

**Action**:
- Create integration test suite using the mock factory (`src/tests/helpers/mocks.ts`)
- Test each sub-workflow JSON end-to-end: correct data flow, correct field names, no undefined reads
- Add regression tests for the composite wrappers (backward compatibility guarantee)

---

## 🟡 P1 — High

### 5. ~~Batch Memgraph operations~~ ✅ COMPLETED

**Problem**: Several modules issue individual Cypher queries per entity/node (e.g., `CommunityDetector.writeCommunityLabels()`, `ParentChildChunker.persistToGraph()`, `CitationInjector.persistCitations()`). This creates N round-trips for N items.

**Implemented**:
- Added `batchQuery()` helper to `MemgraphClient` that wraps UNWIND patterns
- Rewrote `persistMemoryUnits()` from N queries to 2 (units + relations)
- Converted `CommunityDetector.writeCommunityLabels()` to single UNWIND query
- Converted `ParentChildChunker.persistToGraph()` from 2N to 2 queries
- Converted `CitationInjector.persistCitations()` from N+1 to 2 queries
- Converted `ChunkIngestorModule` from N to 1 query
- Added query count telemetry via `getQueryCount()` on `MemgraphClient`

### 6. ~~Proper error boundaries per module~~ ✅ COMPLETED

**Problem**: Many modules use bare `catch {}` blocks that silently swallow errors. This makes debugging pipeline failures extremely difficult.

**Implemented**:
- Replaced bare `catch {}` with `catch (err) { ctx.logger.warn/debug(...) }` across 15+ modules
- Key files: CommunityDetector, ParentChildChunker, CitationInjector, ChunkIngestor, FactExtractor, SemanticSynthesis, GraphSearch, StateStore, AutonomousLoop
- Propagated structured error metadata via `ModuleOutput.metrics`
- Added `--strict` mode foundation in `WorkflowEngine` via config validation (Improvement #11)

### 7. ~~MemoryUnit field propagation~~ ✅ COMPLETED

**Problem**: The new `userContent`, `modelContent`, `modelId`, `providerId`, `userId`, and `topicLabel` fields on `MemoryUnit` are defined but no existing module populates them.

**Implemented**:
- `FactExtractor`: Sets `modelId` and `providerId` from `WorkflowContext.globalConfig` after LLM extraction
- `TopicSegmenter`: Sets `topicLabel` from segment analysis using entity-based or keyword-based heuristics
- Both fallback and primary extraction paths now populate provenance fields

### 8. ~~TOML prompt coverage~~ ✅ COMPLETED

**Problem**: Several modules reference TOML prompts that may not exist yet: `simplemem/synthesis.toml`, `simplemem/intent_aware_planning.toml`, `lightmem/pre_compression.toml`.

**Implemented**:
- Added `validateAllPrompts()` to `promptLoader.ts` that checks all 25+ known TOML prompt references against actual files in `src/prompts/`
- Wired into `WorkflowContext.create()` for fail-fast error surfacing at startup — missing or malformed prompts are logged as warnings
- Added `GET /prompts/validate` API endpoint for runtime validation
- All referenced TOML files verified to exist on disk

### 9. ~~Streaming support~~ ✅ COMPLETED

**Problem**: `POST /workflow/run` returns only after the entire pipeline completes. For 10-60 second pipelines, the user sees nothing — creating perceived latency, no abort opportunity, and no partial-value delivery.

**Implemented**:
- Added `StreamEvent` discriminated union (7 event types) and `StreamableModule<T>` interface to `types.ts` — **100% additive, zero breaking changes**
- Added `WorkflowEventEmitter` (`src/core/WorkflowEventEmitter.ts`) — typed wrapper around Node.js's native `EventEmitter` with per-event-type `on()`/`once()`/`off()`, wildcard `*` channel, and `toAsyncGenerator()` bridge
- Added `WorkflowEngine.runStream()` AsyncGenerator that yields events as stages execute — dual-emits via both the generator and the EventEmitter
- Added `WorkflowEngine.events` getter exposing the typed emitter for direct subscription (SSE, metrics, tests)
- Added `executeDAGStreaming()` and `executeStageStreaming()` with runtime `processStream()` detection
- Added `POST /workflow/run/stream` SSE endpoint using Hono's `streamSSE()` helper with abort handling
- Implemented `processStream()` on `AnswerGenerator` and `FinalSynthesizer` using LangChain `.stream()` for token-level output
- Added `generatePreview()` for stage:complete events (auto-summarizes output for UI display)
- Non-streaming `run()` path completely unmodified — streaming is a parallel execution path
- Bun/Node server banners updated with new endpoint
- `shutdown()` cleans up all emitter listeners

**Non-breaking design**:
- `BaseModule.process()` is unchanged. `StreamableModule.processStream()` is optional.
- Modules without `processStream()` automatically fall back to `process()` + single `stage:complete`
- Existing `POST /workflow/run` works identically
- `engine.events` allows multi-consumer access without SSE (metrics, logging, tests)

### 10. ~~Module-level telemetry~~ ✅ COMPLETED

**Problem**: Per-stage timing exists in the trace accumulator but there's no structured telemetry for module-level resource consumption (LLM tokens, Memgraph queries, embedding calls).

**Implemented**:
- Added `tokenUsage`, `memgraphQueries`, `embeddingCalls` optional counters to `ModuleMetrics` type
- `MemgraphClient`: Added `getQueryCount()` / `resetQueryCount()` for per-stage query tracking
- `FactExtractor`: Emits `embeddingCalls` and `tokenUsage` in metrics
- `ChunkIngestor`: Emits `memgraphQueries` in metrics
- Aggregated in `/workflow/run` API response as `telemetry` object for cost estimation

---

## 🟢 P2 — Medium

### 11. ~~Module config validation at workflow load time~~ ✅ COMPLETED

**Problem**: Module configs are validated at `process()` time via Zod. If a workflow JSON has an invalid config, it only fails when that stage executes — potentially minutes into a long-running pipeline.

**Implemented**:
- Added `validateModuleConfigs()` pass during both `WorkflowEngine.initialize()` and `initializeWithContext()`
- Resolves each module, calls `getConfigSchema().parse()` on the stage config
- Collects all validation errors and surfaces them as a single `WorkflowConfigError` before execution begins

### 12. ~~Decouple AutonomousLoop from SubWorkflowModule import~~ ✅ COMPLETED

**Problem**: `AutonomousLoopModule` directly imports `SubWorkflowModule`, bypassing the `ModuleRegistry`. This creates a tight coupling.

**Implemented**:
- Replaced `import { SubWorkflowModule }` with `ModuleRegistry.getInstance().getModule("SubWorkflow", ...)`
- AutonomousLoop can now wrap any registered module, not just sub-workflows
- Module instances are properly scoped with per-iteration cache keys

### 13. ~~Community-aware graph search~~ ✅ COMPLETED

**Problem**: `GraphSearch` doesn't leverage the `communityId` property written by `CommunityDetector`. High-level queries could benefit from community-scoped search.

**Implemented**:
- Added `communityScope` and `maxCommunitySummaries` config to `GraphSearchModule`
- When `communityScope` is true and `searchScope` is `high`/`exploratory`/`analytical`, queries `:Community` node summaries for theme-based retrieval
- For each matching community, also retrieves member entity chunks scoped to that community
- Low-level queries continue using standard entity-centric graph traversal
- Bumped `GraphSearchModule` to v0.4.0

### 14. ~~Configurable similarity function~~ ✅ COMPLETED (v0.3.0 + v0.4.0)

**Problem**: All modules hardcode cosine similarity. Some use cases (e.g., BM25 lexical matching, Jaccard for set overlap) would benefit from alternative distance metrics.

**Implemented** (v0.3.0):
- Extracted `similarity.ts` into a strategy pattern with `cosine`, `euclidean`, `dotProduct` options
- Added `similarity()` dispatcher function that accepts a `SimilarityFunction` parameter
- `euclideanSimilarity()` normalizes to (0,1] range via `1/(1+distance)` for consistent thresholding
- Added `similarityFunction` config to: `NoveltyGate`, `SemanticSynthesis`, `TopicSegmenter`

**Implemented** (v0.4.0 — completion):
- Extended `similarityFunction` config to `CrossEventConsolidation` (v0.4.0) and `SleepConsolidation` (v0.4.0)
- All 5 similarity-dependent modules now support the configurable strategy pattern

### 15. ~~Hot-reload for TOML prompts~~ ✅ COMPLETED

**Problem**: Changing a TOML prompt requires restarting the server. In a prompt-engineering loop, this is friction.

**Implemented**:
- Added `startPromptWatcher()` to `promptLoader.ts` using `fs.watch` with recursive directory monitoring
- Debounced cache invalidation (300ms) to avoid rapid successive reloads
- Auto-started in `WorkflowContext.create()` — prompt changes reflect immediately without restart
- Added `POST /prompts/reload` endpoint for manual cache invalidation
- Added `stopPromptWatcher()` for graceful shutdown

### 16. ~~Workflow versioning and migration~~ ✅ COMPLETED

**Problem**: Workflow JSON files have no version field. When module interfaces change, existing workflows silently break.

**Implemented**:
- Added `"version"` field to `WorkflowConfigSchema` with default `"1.0"` for backward compatibility
- Added `SUPPORTED_VERSIONS` constant: current (`1.0`, `1.1`) and deprecated (`0.1`, `0.2`)
- `validateVersion()` runs during WorkflowEngine construction — rejects unsupported versions with clear error messages
- Deprecated versions emit warnings during `initialize()` recommending migration
- Version logged in workflow initialization traces for observability

---

## ⚪ P3 — Future Exploration

### 17. GPU-accelerated community detection

MAGE supports Nvidia cuGraph for Louvain and Leiden. For large knowledge graphs (>100K entities), the current CPU-based detection becomes a bottleneck.

### 18. Online community detection

MAGE's `community_detection_online` processes node arrivals in constant time. This would enable real-time community updates as new entities are ingested, rather than re-running full detection.

### 19. Multi-modal memory units

The current `MemoryUnit` is text-only. Research papers on multi-modal RAG suggest storing image embeddings, audio transcripts, and video keyframes as memory units.

### 20. Distributed workflow execution

For production deployments with high concurrency, the `WorkflowEngine` could distribute stages across workers via a message queue (Redis Streams, NATS). Each module's `process()` is already stateless (state is in Memgraph), making this architecturally feasible.

### 21. Formal module dependency graph

Build a static analysis tool that reads all module files and extracts their `input.data.*` reads and `output.data.*` writes. Use this to:
- Auto-validate that workflow JSON stages have compatible I/O chains
- Generate visual dependency graphs
- Detect dead data (fields written but never read downstream)

### 22. Adaptive module selection

The AutonomousLoop currently mutates input data. A more sophisticated approach would dynamically swap modules — e.g., replacing `ResultRanker` with `SetUnionMerger` based on observed retrieval quality, or switching `KeywordSearch` from `text_search` to `bm25` mode automatically.
