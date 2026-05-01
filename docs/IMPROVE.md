# MemFlow Improvement Roadmap

> Technical debt, performance optimizations, and missing implementations identified during architectural audit.

## Completion Tracker (v0.4.0)

| # | Improvement | Status | Version |
|---|---|---|---|
| 1 | Install deps & validate build | 🔄 In Progress | v0.4.0 |
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

> **13 of 22 items completed** (3 P0 critical, 2 P1 high remain open)

## Priority Key

| Priority | Meaning |
|---|---|
| 🔴 P0 | Critical — blocking production readiness or correctness |
| 🟡 P1 | High — significant quality or performance improvement |
| 🟢 P2 | Medium — nice-to-have, developer experience, maintainability |
| ⚪ P3 | Low — future exploration, research alignment |

---

## 🔴 P0 — Critical

### 1. ~~Install dependencies and validate build~~ 🔄 IN PROGRESS

**Problem**: `node_modules/` is absent — no TypeScript compilation has been verified against the current codebase.

**Progress (v0.4.0 — Bun migration)**:
- Migrated `package.json` to Bun-first: `@hono/node-server` moved to `optionalDependencies`, `engines` field specifies `bun >= 1.0.0`
- Updated `tsconfig.json`: `moduleResolution: "bundler"` (Bun's resolver), `types: ["bun-types"]`
- Added `typecheck` and `lint` scripts: `bun run typecheck` / `bun run lint`
- Dockerfile rewritten as multi-stage build with `oven/bun:1` builder
- Docker Compose updated (removed deprecated `version` key)

**Remaining**:
- Run `bun install` and `bun run typecheck` to validate build
- Fix any type errors
- Add a CI step that runs `bun run typecheck` on every commit

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

### 6. ~~Proper error boundaries~~ ✅ COMPLETED

**Problem**: Several modules have bare `catch {}` blocks that swallow errors silently.

**Implemented**:
- Replaced 15+ bare `catch {}` blocks with structured logging via `context.logger.warn()`
- Each catch block now logs the error message and relevant context (node IDs, query details, batch sizes)
- Modules: `MarkdownSpatialParser`, `S2Chunker`, `EntityExtractor`, `EntityDeduplicator`, `CommunityDetector`, `CrossEventConsolidation`, `SleepConsolidation`, `SemanticSynthesis`, `TopicBoundaryDetector`, `LightMem`, `StructMem`, `SimpleMem`, `HERA`, `PriHA`, `AutoResearchClaw`

### 7. ~~MemoryUnit field propagation~~ ✅ COMPLETED

**Problem**: The `MemoryUnit` interface has been enriched with cross-event fields (`eventId`, `eventType`, `importance`, `decayFactor`, `consolidatedFrom`) but some modules don't populate them.

**Implemented**:
- Added `eventId`, `eventType`, `importance`, `decayFactor`, `consolidatedFrom` to all MemoryUnit-producing paths
- `FactExtractor`, `CrossEventConsolidation`, `SleepConsolidation`, `SemanticSynthesis` all propagate these fields

### 8. ~~TOML prompt coverage~~ ✅ COMPLETED

**Problem**: Some modules use hardcoded string templates or LangChain prompt classes instead of the externalised TOML prompt system.

**Implemented**:
- Added `loadAndRender()` utility with Handlebars-style `{{variable}}` template rendering
- Migrated all 25+ prompt references to TOML files in `src/prompts/`
- Added `validateAllPrompts()` startup validation
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
- `FactExtractor`: Emits `embeddingCalls` and `tokenUsage` based on LLM/embedding invocations
- `ChunkIngestor`: Emits `memgraphQueries` via `MemgraphClient.getQueryCount()`
- `POST /workflow/run` response includes aggregated `telemetry` object across all stages

### 11. ~~Config validation at load time~~ ✅ COMPLETED

**Implemented**:
- Added `validateModuleConfigs()` called during `initialize()` — validates all stage configs via Zod schemas before any execution begins
- Added `WorkflowConfigSchema` with `z.object()` validation for the workflow structure itself
- Config errors surface at startup with clear messages (module name, field, expected type)

### 12. ~~Decouple AutonomousLoop~~ ✅ COMPLETED

**Implemented**:
- `AutonomousLoop` now resolves sub-workflows via `ModuleRegistry.resolve()` instead of direct `SubWorkflowModule` import
- Removes circular dependency between core and module layers

---

## 🟢 P2 — Medium

### 13. ~~Community-aware graph search~~ ✅ COMPLETED

**Implemented**:
- `GraphSearch` supports `communityScope: true` config option
- When `searchScope` is 'broad'/'exploratory', queries `:Community` summary nodes
- Community summaries are merged into graph context for high-level topic retrieval

### 14. ~~Configurable similarity function~~ ✅ COMPLETED

**Implemented**:
- Strategy pattern (`cosine`, `euclidean`, `dotProduct`) across all 5 similarity-dependent modules
- `CrossEventConsolidation` and `SleepConsolidation` added in v0.4.0 (completing coverage)

### 15. ~~Hot-reload for TOML prompts~~ ✅ COMPLETED

**Implemented**:
- `fs.watch`-based watcher on `src/prompts/` directory
- `clearPromptCache()` invalidates on file change
- `POST /prompts/reload` API endpoint for manual invalidation
- Eliminates server restarts during prompt engineering

### 16. ~~Workflow versioning and migration~~ ✅ COMPLETED

**Implemented**:
- `SUPPORTED_VERSIONS` constant with `current` and `deprecated` arrays
- Constructor validates version field, rejects unsupported, warns on deprecated
- Default version `"1.0"` for backward compatibility

### 17. Observability dashboard

**Problem**: No built-in way to visualise workflow execution, stage timing, error rates, or module performance.

**Action**:
- Expose Prometheus-compatible `/metrics` endpoint
- Track: stage latency histograms, error rates by module, token usage counters
- Add Grafana dashboard template in `docker/grafana/`

### 18. Rate limiting and backpressure

**Problem**: No protection against overwhelming the LLM provider or Memgraph with concurrent requests.

**Action**:
- Add configurable rate limiter for LLM calls (token bucket)
- Add concurrency limiter for Memgraph queries
- Implement backpressure signalling in the WorkflowEngine

---

## ⚪ P3 — Low / Future

### 19. Plugin system for custom modules

**Action**:
- Allow loading modules from external npm packages via `@memflow/plugin-*` convention
- Module discovery via package.json `memflow.modules` field

### 20. Multi-tenant workflow isolation

**Action**:
- Per-tenant Memgraph namespacing (node labels or separate databases)
- Tenant-scoped StateStore keys

### 21. Workflow versioning with migration scripts

**Action**:
- Automatic workflow JSON migration when schema versions change
- Migration registry with up/down transforms

### 22. WebSocket support for bidirectional communication

**Action**:
- Allow clients to send control messages mid-workflow (pause, resume, cancel, inject data)
- Complement the existing SSE streaming with full duplex communication
