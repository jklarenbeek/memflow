# Hybrid Retrieval Pipeline

> **Paper**: LightRAG  
> **Composite Wrapper**: `LightRAGRetrieverModule` (`modules/retrieval/LightRAGRetrieverModule.ts`)  
> **Sub-Workflow**: `hybrid-retrieval.json` — IntentClassifier → [VectorSearch ∥ GraphSearch ∥ KeywordSearch] → ResultRanker

The hybrid retrieval pipeline implements a three-way parallel fan-out search (vector, graph, keyword) with intent-aware routing and unified result ranking. It is the primary retrieval mechanism used by the `quick-qa` and `rag-memory-pipeline` example workflows.

The `LightRAGRetrieverModule` wrapper delegates all retrieval logic to the `hybrid-retrieval.json` sub-workflow. Its `buildStageConfigs()` method distributes the flat config surface (e.g., `topK`, `hybridWeights`, `usePyramid`) into per-stage overrides for the individual search modules.

Each search module emits a uniquely prefixed metric (`vectorHits`, `graphHits`, `keywordHits`) to prevent name collisions when stages execute in parallel.

**Config (wrapper)**:
- `topK` (8) — final result count
- `useGraph` (true) — enable graph search
- `useVector` (true) — enable vector search
- `usePyramid` (true) — enable pyramid expansion in ranking
- `intentAware` (true) — enable intent classification
- `hybridWeights` — `{ vector: 0.5, graph: 0.3, keyword: 0.2 }`
- `tokenBudget` (4000) — max tokens in ranked output

---

## Atomic Modules

### IntentClassifier

| | |
|---|---|
| **File** | `modules/retrieval/IntentClassifierModule.ts` |
| **Input** | `query` |
| **Output** | `searchScope` |

Classifies query intent to determine search scope (factual, exploratory, analytical).

### DualLevelRouter

| | |
|---|---|
| **File** | `modules/retrieval/DualLevelRouterModule.ts` |
| **Input** | `query`, `searchScope` |
| **Output** | `retrievalLevel`, `lowLevelQueries`, `highLevelQueries` |
| **Config** | `defaultLevel`, `maxLowLevelQueries`, `maxHighLevelQueries` |

Routes queries to low-level (entity/fact → graph traversal) vs high-level (theme/topic → community retrieval). LLM classification with heuristic fallback.

### VectorSearch

| | |
|---|---|
| **File** | `modules/retrieval/VectorSearchModule.ts` |
| **Input** | `query` |
| **Output** | `candidates` (appended, `source="vector"`) |
| **Metrics** | `vectorHits` |
| **Config** | `topK`, `weight` |

Memgraph vector index cosine search on `:Chunk` embeddings.

### GraphSearch

| | |
|---|---|
| **File** | `modules/retrieval/GraphSearchModule.ts` |
| **Input** | `query`, `searchScope` |
| **Output** | `candidates` (appended, `source="graph"` or `source="graph-community"`) |
| **Metrics** | `graphHits` |
| **Config** | `topK`, `weight`, `maxHops`, `communityScope`, `maxCommunitySummaries` |

Entity-centric graph traversal via Memgraph — matches query entities, expands neighbourhood. Community-aware mode: when `communityScope: true` and `searchScope` is `high`/`exploratory`/`analytical`, queries `:Community` node summaries for theme-based retrieval.

### KeywordSearch

| | |
|---|---|
| **File** | `modules/retrieval/KeywordSearchModule.ts` |
| **Input** | `query` |
| **Output** | `candidates` (appended, `source="keyword"`) |
| **Metrics** | `keywordHits` |
| **Config** | `topK`, `weight`, `searchMode` (`text_search` or `bm25`), `bm25K1`, `bm25B` |

Dual search mode: basic Memgraph text index search or MAGE BM25 scoring with configurable k1 (term saturation) and b (length normalization). Graceful fallback from BM25 to text_search.

### SymbolicSearch

| | |
|---|---|
| **File** | `modules/retrieval/SymbolicSearchModule.ts` |
| **Paper** | SimpleMem §2.1 |
| **Input** | `query`, `symbolicFilter`, `memoryUnits` |
| **Output** | `candidates` (appended, `source="symbolic"`) |

Queries memory units by structured metadata constraints (type, entities, time range, confidence) from `StructuredIndex`. Memgraph-backed with in-memory filtering fallback.

### ResultRanker

| | |
|---|---|
| **File** | `modules/retrieval/ResultRankerModule.ts` |
| **Input** | `candidates` |
| **Output** | `retrievalResult` |
| **Config** | `tokenBudget`, `weights` |

Deduplicates, scores (weighted by source), applies pyramid expansion with budget gating, retrieves full `MemoryUnit` objects.

### SetUnionMerger

| | |
|---|---|
| **File** | `modules/retrieval/SetUnionMergerModule.ts` |
| **Paper** | OMNI-SIMPLEMEM §4.2 |
| **Input** | `candidates` |
| **Output** | `candidates` (deduplicated union), `retrievalResult` |
| **Config** | `maxCandidates`, `tokenBudget` |

Drop-in alternative to `ResultRanker`. Set-union deduplication by ID (keeps highest-scoring per ID).
