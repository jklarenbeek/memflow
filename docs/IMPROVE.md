# MemFlow — Improvement Roadmap

> Actionable improvements derived from architectural analysis, paper alignment audit, and codebase review.

## Completion Tracker

| # | Improvement | Status | Version |
|---|---|---|---|
| 5 | Batch Memgraph operations | ✅ Completed | v0.3.0 |
| 6 | Proper error boundaries | ✅ Completed | v0.3.0 |
| 7 | MemoryUnit field propagation | ✅ Completed | v0.3.0 |
| 10 | Module-level telemetry | ✅ Completed | v0.3.0 |
| 11 | Config validation at load time | ✅ Completed | v0.3.0 |
| 12 | Decouple AutonomousLoop | ✅ Completed | v0.3.0 |
| 14 | Configurable similarity function | ✅ Completed | v0.3.0 |

> **7 of 22 items completed** (4 P0 critical, 8 P1 high remain open)

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

### 8. TOML prompt coverage

**Problem**: Several modules reference TOML prompts that may not exist yet: `simplemem/synthesis.toml`, `simplemem/intent_aware_planning.toml`, `lightmem/pre_compression.toml`.

**Action**:
- Audit all `loadAndRender()` calls against actual files in `src/prompts/`
- Create missing TOML files with appropriate `[meta]`, `[config]`, and `[[messages]]` sections
- Add a startup validation step that checks all referenced prompts exist

### 9. Streaming support

**Problem**: All modules return complete results. For large documents or long-running agent pipelines, users see no output until the entire pipeline completes.

**Action**:
- Add `processStream()` to the `BaseModule` interface (optional method)
- Implement streaming in `AnswerGenerator` and `FinalSynthesizer` for real-time token output
- Expose SSE (Server-Sent Events) on the Hono HTTP server for `/workflow/run` responses

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

### 13. Community-aware graph search

**Problem**: `GraphSearch` doesn't leverage the `communityId` property written by `CommunityDetector`. High-level queries could benefit from community-scoped search.

**Action**:
- Add `communityScope` config to `GraphSearchModule`
- When `DualLevelRouter` returns `level="high"`, scope graph traversal to matching communities
- Use `:Community` node summaries for theme-based retrieval without entity matching

### 14. ~~Configurable similarity function~~ ✅ COMPLETED

**Problem**: All modules hardcode cosine similarity. Some use cases (e.g., BM25 lexical matching, Jaccard for set overlap) would benefit from alternative distance metrics.

**Implemented**:
- Extracted `similarity.ts` into a strategy pattern with `cosine`, `euclidean`, `dotProduct` options
- Added `similarity()` dispatcher function that accepts a `SimilarityFunction` parameter
- `euclideanSimilarity()` normalizes to (0,1] range via `1/(1+distance)` for consistent thresholding
- Added `similarityFunction` config to: `NoveltyGate`, `SemanticSynthesis`, `TopicSegmenter`
- `CrossEventConsolidation` and `SleepConsolidation` can also be updated (left for next iteration)

### 15. Hot-reload for TOML prompts

**Problem**: Changing a TOML prompt requires restarting the server. In a prompt-engineering loop, this is friction.

**Action**:
- Add file watcher (via `fs.watch` or Bun's native watcher) to `src/prompts/`
- Invalidate the `promptLoader` cache on file change
- Expose a `/prompts/reload` endpoint for manual cache invalidation

### 16. Workflow versioning and migration

**Problem**: Workflow JSON files have no version field. When module interfaces change, existing workflows silently break.

**Action**:
- Add `"version": "1.0"` to workflow JSON schema
- Implement version compatibility checks during `initialize()`
- Provide migration scripts when breaking changes are introduced

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
