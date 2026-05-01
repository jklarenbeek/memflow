# MemFlow Module Reference (v0.4.0)

> Canonical reference for all 56 registered modules. Each module is a self-contained unit with a strict input → output fingerprint on the shared `WorkflowData` bus.

---

## How to Read This Document

Each module entry follows this structure:

| Field | Meaning |
|---|---|
| **Registry Key** | Name used in workflow JSON `"module"` field |
| **Paper** | Source research paper and section |
| **Input** | WorkflowData fields read by `process()` |
| **Output** | WorkflowData fields written by `process()` |
| **Side-effects** | Memgraph writes, state mutations, etc. |
| **Config** | Key Zod-validated configuration parameters |
| **Version** | Current semantic version |

---

## 1 — Core Modules

### SubWorkflow

| | |
|---|---|
| **File** | `modules/core/SubWorkflowModule.ts` |
| **Input** | Mapped from parent via `inputMap` |
| **Output** | Mapped to parent via `outputMap` |
| **Config** | `workflowRef` (file path) or `workflow` (inline JSON), `inputMap`, `outputMap` |
| **Version** | 0.2.0 |

Enables workflows-within-workflows. Loads a child workflow JSON, instantiates a nested `WorkflowEngine` sharing the parent's `WorkflowContext`, and maps data in/out. Recursion depth guard (default max 5).

### AutonomousLoop

| | |
|---|---|
| **File** | `modules/core/AutonomousLoopModule.ts` |
| **Paper** | OMNI-SIMPLEMEM §3 |
| **Input** | Passthrough to child workflow |
| **Output** | Passthrough from child + `autonomousLoopMetrics` |
| **Config** | `workflowRef`, `targetMetric` (dot-path), `targetThreshold`, `maxIterations`, `inputMap`, `outputMap` |
| **Version** | 0.1.0 |

Meta-module that wraps any sub-workflow in an iterative diagnosis-and-repair loop. Executes → evaluates metric → if below target: LLM diagnoses failure, generates config mutations → re-executes. Accepts or reverts based on metric delta. Best result is always returned. **Decoupled from SubWorkflowModule** — uses `ModuleRegistry.resolve()` instead of direct import, enabling it to wrap any registered module.

---

## 2 — Chunking Modules

### S2Chunker

| | |
|---|---|
| **File** | `modules/chunking/S2ChunkerModule.ts` |
| **Paper** | S2 Chunking (arXiv:2501.05485) |
| **Input** | `documents` or `markdown` |
| **Output** | `chunks` |
| **Config** | `alpha` (semantic vs spatial weight, default 0.5), `maxChunkSize`, `minChunkSize` |
| **Version** | 0.2.0 |

Real spectral clustering: affinity matrix → normalised Laplacian → Jacobi eigensolver → eigengap heuristic for k → K-Means++ on eigenvectors. Extends LangChain `TextSplitter`. L2-normalised embeddings, reading-order reconstruction. **Deviation**: configurable `alpha` instead of the paper's fixed average.

### MarkdownSpatialParser

| | |
|---|---|
| **File** | `modules/chunking/MarkdownSpatialParserModule.ts` |
| **Input** | `markdown` (string) |
| **Output** | `chunks` (spatial elements with position metadata) |
| **Version** | 0.2.0 |

Converts Markdown into spatial elements with layout-aware position metadata. Companion to S2Chunker — feeds spatial affinity signals into the spectral clustering.

### ParentChildChunker

| | |
|---|---|
| **File** | `modules/chunking/ParentChildChunkerModule.ts` |
| **Paper** | PriHA |
| **Input** | `chunks` |
| **Output** | `parentChunks`, `childChunks`, `chunkRelations`, `chunks` (children for compatibility) |
| **Side-effects** | Creates `:ParentChunk` and `:ChildChunk` nodes with `:BELONGS_TO` edges in Memgraph |
| **Config** | `childChunkSize` (200 tokens), `parentChunkSize` (1000 tokens), `childOverlapTokens`, `parentOverlapTokens`, `persistToGraph` |
| **Version** | 0.1.0 |

Two-tier chunking: small child chunks for precise retrieval, large parent chunks for broad context. During retrieval, search matches against children but returns parent chunks for full context window. **Uses `batchQuery()` UNWIND** for batch graph persistence (2N→2 round-trips).

---

## 3 — Memory Modules

### 3.1 SimpleMem Pipeline

Sub-workflow (write): `simplemem-pipeline.json` — `Window → Gate → Extract → Synthesize → Index`
Sub-workflow (read): `simplemem-retrieval.json` — `Plan → [Sem ∥ Lex ∥ Sym] → Rank`

#### SlidingWindow

| | |
|---|---|
| **File** | `modules/memory/SlidingWindowModule.ts` |
| **Paper** | SimpleMem §2 |
| **Input** | `chunks` |
| **Output** | `windowedChunks` |
| **Config** | `windowSize`, `windowOverlap` |

Groups chunks into overlapping temporal windows for context-preserving downstream processing.

#### DensityGate

| | |
|---|---|
| **File** | `modules/memory/DensityGateModule.ts` |
| **Paper** | SimpleMem Eq.1 |
| **Input** | `windowedChunks` |
| **Output** | `filteredChunks` |
| **Config** | `minFactCount` |

Implements Φ_gate(W) — LLM-based semantic density evaluation with heuristic fallback. Only windows with `≥ minFactCount` distinct facts pass through.

#### FactExtractor

| | |
|---|---|
| **File** | `modules/memory/FactExtractorModule.ts` |
| **Paper** | SimpleMem §2 |
| **Input** | `filteredChunks` |
| **Output** | `memoryUnits` |

LLM de-linearisation of text into typed `MemoryUnit` objects with batch embedding. Supports coreference resolution via the extraction TOML prompt. **Populates `modelId` and `providerId`** from `WorkflowContext.globalConfig` for provenance tracking. Emits `embeddingCalls` and `tokenUsage` telemetry counters in `metrics`.

#### SemanticSynthesis

| | |
|---|---|
| **File** | `modules/memory/SemanticSynthesisModule.ts` |
| **Paper** | SimpleMem §2 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (merged) |
| **Config** | `synthesisThreshold` (default 0.82), `useLLM` (default true), `similarityFunction` (`"cosine"` / `"euclidean"` / `"dotProduct"`, default `"cosine"`) |

Cosine-based merge of highly similar units (strictly `> threshold`). Averages embeddings and combines content. **Configurable similarity function** allows switching between cosine, euclidean, and dot product strategies for cluster detection.

#### StructuredIndex

| | |
|---|---|
| **File** | `modules/memory/StructuredIndexModule.ts` |
| **Paper** | SimpleMem §2 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (enriched with lexical + symbolic metadata) |

Multi-view indexing: enriches each unit with TF-based lexical keywords and structured symbolic metadata (type, timestamp, confidence) for complementary retrieval paths.

#### IntentAwarePlanner

| | |
|---|---|
| **File** | `modules/memory/IntentAwarePlannerModule.ts` |
| **Paper** | SimpleMem §2.3 |
| **Input** | `query`, `memoryUnits` |
| **Output** | `expandedQueries`, `semanticQuery`, `lexicalQuery`, `symbolicFilter`, `retrievalDepth` |

Decomposes query into three complementary retrieval signals — `{qₛₑₘ, qₗₑₓ, qₛᵧₘ, d}` — where `d` is adaptive retrieval depth. LLM with heuristic fallback.

### 3.2 LightMem Pipeline

Sub-workflow: `lightmem-pipeline.json` — `PreCompress → SensoryBuffer → [cond] → NoveltyGate → TopicSegmenter → STMBuffer → SleepConsolidation`

Implements all three tiers: Light₁ (compression + sensory buffer), Light₂ (novelty + segmentation + STM), Light₃ (sleep consolidation).

#### PreCompression

| | |
|---|---|
| **File** | `modules/memory/PreCompressionModule.ts` |
| **Paper** | LightMem §3.1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (compressed, redundancy removed) |

LLM-based cross-entropy density scoring per sentence (approximates Python-only LLMLingua-2). Retains only sentences above the τ-percentile threshold.

#### SensoryBuffer

| | |
|---|---|
| **File** | `modules/memory/SensoryBufferModule.ts` |
| **Paper** | LightMem §3.1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (flushed when buffer ≥ th tokens, `[]` otherwise) |
| **Side-effects** | Crash-recoverable Memgraph-backed buffer state |

Accumulates compressed units until capacity `th` tokens is reached, then flushes downstream.

#### NoveltyGate

| | |
|---|---|
| **File** | `modules/memory/NoveltyGateModule.ts` |
| **Paper** | LightMem Tier 1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (novel only) |
| **Config** | `noveltyThreshold`, `similarityFunction` (`"cosine"` / `"euclidean"` / `"dotProduct"`, default `"cosine"`) |
| **Version** | 0.3.0 |

Similarity filtering against existing memories. Checks both existing units and already-accepted batch units to prevent intra-batch duplicates. **Configurable similarity function** allows switching between cosine, euclidean, and dot product strategies.

#### TopicSegmenter

| | |
|---|---|
| **File** | `modules/memory/TopicSegmenterModule.ts` |
| **Paper** | LightMem §3.2 |
| **Input** | `memoryUnits` |
| **Output** | `topicSegments` |
| **Config** | `topicSimilarityThreshold`, `minSegmentSize`, `similarityFunction` (`"cosine"` / `"euclidean"` / `"dotProduct"`, default `"cosine"`) |
| **Version** | 0.3.0 |

Hybrid B1∩B2 boundary detection — B1 = local similarity minima (or attention scores from `AttentionScoreModule`); B2 = threshold drops. Final boundaries = B1∩B2 with B2 fallback. Small segments merged into adjacent. **Derives `topicLabel`** for each segment using entity-based or keyword-based heuristics, populating the `MemoryUnit.topicLabel` field. **Configurable similarity function** via strategy pattern.

#### AttentionScore

| | |
|---|---|
| **File** | `modules/memory/AttentionScoreModule.ts` |
| **Paper** | LightMem §3.2 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (with `metadata.attentionBoundaryScore`) |
| **Config** | `batchSize`, `boundaryMinScore` |

LLM-based approximation of LLMLingua-2 attention scores. Produces `attentionBoundaryScore` metadata for `TopicSegmenter` B1 signal. Opt-in; inserted before TopicSegmenter.

#### STMBuffer

| | |
|---|---|
| **File** | `modules/memory/STMBufferModule.ts` |
| **Paper** | LightMem §3.2 |
| **Input** | `topicSegments` |
| **Output** | `memoryUnits` (LTM-promoted: `{topic, eᵢ, userᵢ, modelᵢ}`) |

Accumulates topic segments and promotes to LTM format when capacity is reached.

#### SleepConsolidation

| | |
|---|---|
| **File** | `modules/memory/SleepConsolidationModule.ts` |
| **Paper** | LightMem §3.3 |
| **Input** | `topicSegments` |
| **Output** | `memoryUnits` (LTM) |
| **Config** | `ltmMaxSize`, `softUpdateThreshold`, `updateQueueSize`, `enableOfflineQueues`, `similarityFunction` (`"cosine"` / `"euclidean"` / `"dotProduct"`, default `"cosine"`) |
| **Version** | 0.4.0 |

Parallel LLM summarization of topic segments. Per-entry update queues `Q(eᵢ) = Topk({eⱼ, sim(vᵢ, vⱼ)} | tⱼ ≥ tᵢ)` with `Promise.allSettled`. Soft-update LTM: `newTs >= existingTs` constraint. Legacy sequential mode available via `enableOfflineQueues: false`. **Configurable similarity function** via strategy pattern (Improvement #14).

### 3.3 StructMem Pipeline

Sub-workflow: `structmem-pipeline.json` — `DualPersp → Consolidate → Persist`

#### DualPerspective

| | |
|---|---|
| **File** | `modules/memory/DualPerspectiveModule.ts` |
| **Paper** | StructMem §3.1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (enriched with temporal + entity metadata) |

Enriches units with temporal anchoring (ISO timestamps from content) and entity extraction (named entities, event types, interactional relations). LLM-driven with regex NER fallback.

#### CrossEventConsolidation

| | |
|---|---|
| **File** | `modules/memory/CrossEventConsolidationModule.ts` |
| **Paper** | StructMem §3.2 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (with cross-event relations) |
| **Config** | `relationThreshold`, `seedCount`, `timeWindowMs`, `seedSearchWindow`, `similarityFunction` (`"cosine"` / `"euclidean"` / `"dotProduct"`, default `"cosine"`) |
| **Version** | 0.4.0 |

Full Cbuf = Sortτ pipeline: temporally sort buffer → compute aggregated centroid query → retrieve time-bounded seed entries → LLM synthesizes cross-event connections. Fallback: pairwise similarity binding with typed relation inference. **Configurable similarity function** via strategy pattern (Improvement #14).

#### GraphPersist

| | |
|---|---|
| **File** | `modules/memory/GraphPersistModule.ts` |
| **Paper** | StructMem |
| **Input** | `memoryUnits` |
| **Output** | (none — side-effect only) |
| **Side-effects** | Writes `:MemoryUnit` nodes and `:MEMORY_RELATION` edges to Memgraph (via `batchQuery()` UNWIND) |
| **Config** | `batchSize`, `dryRun` |

---

## 4 — Retrieval Modules

Sub-workflow: `hybrid-retrieval.json` — `Intent → [Vector ∥ Graph ∥ Keyword] → Rank`

### IntentClassifier

| | |
|---|---|
| **File** | `modules/retrieval/IntentClassifierModule.ts` |
| **Paper** | LightRAG |
| **Input** | `query` |
| **Output** | `searchScope` |

Classifies query intent to determine search scope (factual, exploratory, analytical).

### DualLevelRouter

| | |
|---|---|
| **File** | `modules/retrieval/DualLevelRouterModule.ts` |
| **Paper** | LightRAG |
| **Input** | `query`, `searchScope` |
| **Output** | `retrievalLevel`, `lowLevelQueries`, `highLevelQueries` |
| **Config** | `defaultLevel`, `maxLowLevelQueries`, `maxHighLevelQueries` |

Routes queries to low-level (entity/fact → graph traversal) vs high-level (theme/topic → community retrieval). LLM classification with heuristic fallback.

### VectorSearch

| | |
|---|---|
| **File** | `modules/retrieval/VectorSearchModule.ts` |
| **Paper** | LightRAG |
| **Input** | `query` |
| **Output** | `candidates` (appended, `source="vector"`) |
| **Config** | `topK`, `weight` |

Memgraph vector index cosine search on `:Chunk` embeddings.

### GraphSearch

| | |
|---|---|
| **File** | `modules/retrieval/GraphSearchModule.ts` |
| **Paper** | LightRAG |
| **Input** | `query`, `searchScope` |
| **Output** | `candidates` (appended, `source="graph"` or `source="graph-community"`) |
| **Config** | `topK`, `weight`, `maxHops`, `communityScope` (bool, default false), `maxCommunitySummaries` (5) |
| **Version** | 0.4.0 |

Entity-centric graph traversal via Memgraph — matches query entities, expands neighbourhood. **Community-aware mode** (Improvement #13): when `communityScope: true` and `searchScope` is `high`/`exploratory`/`analytical`, queries `:Community` node summaries for theme-based retrieval, then retrieves member entity chunks scoped to each matching community.

### KeywordSearch

| | |
|---|---|
| **File** | `modules/retrieval/KeywordSearchModule.ts` |
| **Paper** | LightRAG / MAGE |
| **Input** | `query` |
| **Output** | `candidates` (appended, `source="keyword"`) |
| **Config** | `topK`, `weight`, `searchMode` (`"text_search"` or `"bm25"`), `bm25K1`, `bm25B` |

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
| **Paper** | LightRAG |
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

Drop-in alternative to `ResultRanker`. Set-union deduplication by ID (keeps highest-scoring per ID). The paper discovers this outperforms weighted score fusion.

---

## 5 — Agent Modules (HERA)

Sub-workflow: `hera-orchestration.json` — `Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize`

### PlanGenerator

| | |
|---|---|
| **File** | `modules/agents/PlanGeneratorModule.ts` |
| **Paper** | HERA |
| **Input** | `query`, `retrievalResult` |
| **Output** | `agentPlan` |

LLM generates query-specific agent topology from available roles, informed by experience library and persisted topology mutations.

### TrajectoryExecutor

| | |
|---|---|
| **File** | `modules/agents/TrajectoryExecutorModule.ts` |
| **Paper** | HERA |
| **Input** | `query`, `agentPlan` |
| **Output** | `trajectory` |

Sequential multi-agent execution with accumulated context. Uses evolved prompts (RoPE) when available, TOML role prompts as fallback.

### RewardComputer

| | |
|---|---|
| **File** | `modules/agents/RewardComputerModule.ts` |
| **Paper** | HERA |
| **Input** | `trajectory` |
| **Output** | `trajectory` (with `reward` score) |
| **Config** | `retrievalWeight` (0.3), `stepSuccessWeight` (0.25), `completenessWeight` (0.25), `efficiencyWeight` (0.2) |

Configurable multi-signal composite reward.

### ExperienceReflector

| | |
|---|---|
| **File** | `modules/agents/ExperienceReflectorModule.ts` |
| **Paper** | HERA |
| **Input** | `trajectory` |
| **Output** | `insights`, `experienceLibrary` |

GRPO-style group comparison — ranks current vs prior trajectories, extracts insights, updates library with utility-based pruning.

### RoPEEvolver

| | |
|---|---|
| **File** | `modules/agents/RoPEEvolverModule.ts` |
| **Paper** | HERA §3.4 |
| **Input** | `trajectory`, `evolvedRolePrompts`, `agentFailureBuffers` |
| **Output** | `evolvedRolePrompts` |
| **Config** | `failureThreshold`, `maxPromptLength` |

Identifies weakest agent, runs contrastive LLM analysis. Prompt updates are **consolidated** via projection ΠC (`ρᵢᵗ⁺¹ = ΠC(ρᵢᵗ ⊕ Δρᵢ)`) — merging not overwriting. Integrates per-agent failure buffer for recurring pattern analysis.

### TopologyMutator

| | |
|---|---|
| **File** | `modules/agents/TopologyMutatorModule.ts` |
| **Paper** | HERA §3.5 |
| **Input** | `trajectory`, `consecutiveFailures` |
| **Output** | `mutatedTopology` |
| **Config** | `mutationTriggerCount` |

After N consecutive failures, LLM recommends structural changes (replace/augment agents). Mutations persist and feed into future `PlanGenerator` calls.

### FinalSynthesizer

| | |
|---|---|
| **File** | `modules/agents/FinalSynthesizerModule.ts` |
| **Paper** | HERA §3.3 |
| **Input** | `trajectory` |
| **Output** | `finalAnswer`, `trajectory` (enriched) |
| **Config** | `maxStepChars` (400) |
| **Version** | 0.4.0 |
| **Streaming** | ✅ `processStream()` — yields token-by-token via LangChain `.stream()` |

Synthesizes accumulated agent trajectory steps into a polished, coherent answer. Fallback: returns last step result if LLM synthesis fails. **Implements `StreamableModule`** for real-time token streaming via SSE (Improvement #9).

---

## 6 — Graph Indexing Modules

Sub-workflow: `graph-indexing.json` — `Ingest → Extract → Dedup → Profile → Community`

### ChunkIngestor

| | |
|---|---|
| **File** | `modules/graph/ChunkIngestorModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `chunks`, `embeddings` |
| **Output** | (side-effect: `:Chunk` nodes in Memgraph) |
| **Version** | 0.3.0 |

MERGEs chunk nodes into Memgraph. **Uses `batchQuery()` UNWIND** for N→1 batch ingestion. Emits `memgraphQueries` telemetry counter in `metrics`.

### EntityExtractor

| | |
|---|---|
| **File** | `modules/graph/EntityExtractorModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `chunks` |
| **Output** | `entities`, `relationships` |

LLM entity/relationship extraction via TOML prompt with structured JSON output.

### EntityDeduplicator

| | |
|---|---|
| **File** | `modules/graph/EntityDeduplicatorModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `entities` |
| **Output** | `entities` (canonical) |
| **Config** | `useLLM`, `checkExistingGraph` |

LLM-based canonical name resolution. `checkExistingGraph` queries Memgraph for existing entities before dedup — ensures true incremental graph updates without rebuilding.

### EntityProfiler

| | |
|---|---|
| **File** | `modules/graph/EntityProfilerModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `entities`, `chunks` |
| **Output** | `entities` (with `profileSummary`, `keyThemes`) |

### CommunityDetector

| | |
|---|---|
| **File** | `modules/graph/CommunityDetectorModule.ts` |
| **Paper** | LightRAG |
| **Input** | (graph state) |
| **Output** | `communities`, `communitySummaries` |
| **Side-effects** | Writes `communityId` to `:Entity` nodes, creates `:Community` nodes |
| **Config** | `algorithm` (`"louvain"` / `"leiden"`), `weight`, `coloring`, `minGraphShrink`, `communityAlgThreshold`, `gamma`, `theta`, `generateSummaries`, `maxSummaries` |
| **Version** | 0.3.0 |

Runs MAGE community detection: **Louvain** (`community_detection.get()`, O(n log n)) or **Leiden** (`leiden_community_detection.get()`, O(L·m)). Writes community labels via **`batchQuery()` UNWIND** (N→1 round-trips), generates LLM summaries, persists `:Community` nodes for high-level LightRAG retrieval.

---

## 7 — Generation Modules (PriHA)

Sub-workflow: `priha-fusion.json` — `Clarify → Generate → Validate → Cite`

### QueryClarifier

| | |
|---|---|
| **File** | `modules/generation/QueryClarifierModule.ts` |
| **Paper** | PriHA (PHC-O) |
| **Input** | `query` |
| **Output** | `query` (refined), `clarifications` |

Iterative query decomposition and optimization.

### AnswerGenerator

| | |
|---|---|
| **File** | `modules/generation/AnswerGeneratorModule.ts` |
| **Paper** | PriHA §3.4 |
| **Input** | `query`, `retrievalResult`, `finalAnswer` (optional draft) |
| **Output** | `finalAnswer`, `sources`, `confidence` |
| **Config** | `enableDualSource` (true), `maxContextTokens` (7000) |
| **Version** | 0.4.0 |
| **Streaming** | ✅ `processStream()` — yields token-by-token via LangChain `.stream()` |

Dual-source fusion (official guidelines + dynamic context) → LLM generation. Supports draft refinement mode when `finalAnswer` is already set. **Implements `StreamableModule`** for real-time token streaming via SSE (Improvement #9).

### HallucinationValidator

| | |
|---|---|
| **File** | `modules/generation/HallucinationValidatorModule.ts` |
| **Paper** | PriHA |
| **Input** | `finalAnswer` |
| **Output** | `finalAnswer` (validated), `confidence` |

### CitationInjector

| | |
|---|---|
| **File** | `modules/generation/CitationInjectorModule.ts` |
| **Paper** | PriHA |
| **Input** | `finalAnswer`, `sources` |
| **Output** | `finalAnswer` (cited) |
| **Side-effects** | Creates `:Answer` and `:Citation` nodes with `:CITES` edges in Memgraph |
| **Config** | `style` (`"inline"` / `"footnote"`), `maxCitations`, `persistCitations` |
| **Version** | 0.3.0 |

Inline/footnote citation injection with Memgraph persistence. **Uses `batchQuery()` UNWIND** for batch citation creation (N+1→2 round-trips). Creates `:Answer` and `:Citation` nodes with `:CITES` edges for traceable source attribution.

### WebSearchAgent (stub)

| | |
|---|---|
| **File** | `modules/generation/WebSearchAgentModule.ts` |
| **Paper** | PriHA §3.3 |
| **Input** | `query`, `expandedQueries` |
| **Output** | `webContext`, `webSources`, `webSearchCompleted` (always `false`) |
| **Config** | `maxResults`, `searchProvider`, `urlSafelist` |
| **Version** | 0.1.0 |

**Stub** — awaiting search API provider integration. The PriHA Reconciler (CLocal + CWeb fusion) depends on this module.

---

## 8 — Query Modules

### QueryTranslator

| | |
|---|---|
| **File** | `modules/query/QueryTranslatorModule.ts` |
| **Input** | `query` |
| **Output** | `expandedQueries` |

Five strategies: HyDE, Multi-Query, Step-Back, Query Rewriting, Intent Clarification. Real LLM calls with string-template fallbacks.

---

## 9 — Provider Modules

### Embedder

| | |
|---|---|
| **File** | `modules/providers/EmbedderModule.ts` |
| **Input** | `chunks` or `query` |
| **Output** | `embeddings` |

LangChain embedding provider (Ollama / OpenAI / OpenRouter).

### LLMProvider

| | |
|---|---|
| **File** | `modules/providers/LLMProviderModule.ts` |
| **Input** | `query` |
| **Output** | `finalAnswer` |

LangChain chat model provider (Ollama / OpenAI / OpenRouter). Direct LLM call without retrieval.

---

## 10 — Composite Wrappers (backward compatibility)

These modules delegate all logic to their respective sub-workflows. They exist solely to preserve backward compatibility for workflows referencing the original monolithic module names.

| Module | Delegates To | Sub-Workflow |
|---|---|---|
| **SimpleMem** | 6 atomic memory modules | `simplemem-pipeline.json` |
| **LightMem** | 6 atomic memory modules | `lightmem-pipeline.json` |
| **StructMem** | 3 atomic memory modules | `structmem-pipeline.json` |
| **LightRAGRetriever** | 5 atomic retrieval modules | `hybrid-retrieval.json` |
| **HERAOrchestrator** | 7 atomic agent modules | `hera-orchestration.json` |
| **PriHAFusion** | 4 atomic generation modules | `priha-fusion.json` |
| **MemgraphGraph** | 5 atomic graph modules | `graph-indexing.json` |

The `HERAOrchestrator` wrapper additionally maintains persistent state: `evolvedRolePrompts`, `previousTrajectories`, `consecutiveFailures`, `mutatedTopology`, and `agentFailureBuffers`.

---

## Sub-Workflow Summary

| File | Stages | Paper |
|---|---|---|
| `simplemem-pipeline.json` | Window → Gate → Extract → Synthesize → Index | SimpleMem §2 |
| `simplemem-retrieval.json` | Plan → [Sem ∥ Lex ∥ Sym] → Rank | SimpleMem §2.3 |
| `lightmem-pipeline.json` | PreCompress → SensoryBuffer → [cond] → Novelty → Segment → STMBuffer → Consolidate | LightMem |
| `structmem-pipeline.json` | DualPersp → Consolidate → Persist | StructMem |
| `hera-orchestration.json` | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize | HERA |
| `hybrid-retrieval.json` | Intent → [Vector ∥ Graph ∥ Keyword] → Rank | LightRAG |
| `graph-indexing.json` | Ingest → Extract → Dedup → Profile → Community | LightRAG §3.1 |
| `priha-fusion.json` | Clarify → Generate → Validate → Cite | PriHA |
