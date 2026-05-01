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
    
    WE --> MR["ModuleRegistry (50 modules)"]
    
    MR --> SUB["SubWorkflow"]
    
    subgraph "Atomic Modules"
        MR --> M_MEM["Memory: SlidingWindow, DensityGate, FactExtractor, SemanticSynthesis, NoveltyGate, TopicSegmenter, SleepConsolidation, DualPerspective, CrossEventConsolidation, GraphPersist, StructuredIndex, PreCompression, SensoryBuffer, STMBuffer, IntentAwarePlanner"]
        MR --> M_AGT["Agents: PlanGenerator, TrajectoryExecutor, RewardComputer, ExperienceReflector, RoPEEvolver, TopologyMutator, FinalSynthesizer"]
        MR --> M_RET["Retrieval: IntentClassifier, VectorSearch, GraphSearch, KeywordSearch, ResultRanker, SymbolicSearch"]
        MR --> M_GRF["Graph: ChunkIngestor, EntityExtractor, EntityDeduplicator, EntityProfiler, CommunityDetector"]
        MR --> M_GEN["Generation: QueryClarifier, AnswerGenerator, HallucinationValidator, CitationInjector"]
    end
    
    subgraph "Composite Wrappers (backward compat)"
        MR --> QT["QueryTranslator"]
        MR --> S2["S2Chunker"]
        MR --> MSP["MarkdownSpatialParser"]
        MR --> SM["SimpleMem"]
        MR --> LM["LightMem"]
        MR --> STM["StructMem"]
        MR --> LR["LightRAGRetriever"]
        MR --> HERA["HERAOrchestrator"]
        MR --> PH["PriHAFusion"]
        MR --> MGMOD["MemgraphGraph"]
    end
    
    WE -->|"learning loop"| WE
    WE --> API["Hono HTTP Server"]
    
    SS -->|"flush/restore"| MG
```

## Core Runtime

### WorkflowEngine (`core/WorkflowEngine.ts`)
1. Parse JSON config → validate with Zod
2. `initialize()` → create WorkflowContext, resolve modules, call `init()`
3. `initializeWithContext(parentCtx)` → reuse existing context (for sub-workflows)
4. `run()` → execute DAG with retry, trace, and optional learning iterations
5. `shutdown()` → call `shutdown()` on all modules and context

Features:
- **Parallel DAG execution**: when `next` is an array, branches execute concurrently via `Promise.allSettled`. The `dependsOn` field gates execution until all listed dependencies complete. `maxConcurrency` in `globalConfig` limits parallel width.
- **Configurable conditional routing**: `next` can be `{ "metric>threshold": "stageId", "default": "fallback" }` with operators `>`, `>=`, `<`, `<=`, `==`, `!=`. Bare metric names default to `> 0.5` for backward compatibility.
- **Sub-workflow nesting**: stages with `module: "SubWorkflow"` instantiate a child WorkflowEngine with shared context, controlled by `workflow`/`workflowRef`, `inputMap`, and `outputMap`.
- Exponential backoff retry per stage
- Learning loop with composite scoring
- State export as JSON

### WorkflowContext (`core/WorkflowContext.ts`)
DI container holding all shared runtime resources:
- **MemgraphClient** — singleton, parameterised Cypher only
- **StateStore** — Memgraph-backed persistent state with in-memory LRU cache
- **LLM providers** — cached by `provider:model` key, per-module override
- **Embedding providers** — same caching strategy
- **Winston logger** — structured JSON logging
- **Trace accumulator** — per-stage timing and I/O summaries

### StateStore (`core/StateStore.ts`)
Persistent module state for stateful components (LightMem tiers, HERA experience library):
- **In-memory LRU cache** for zero-latency hot reads within a run
- **Memgraph persistence** via `:ModuleState` nodes for crash recovery
- **Auto-flush** every 5s for dirty entries
- **`restore()`** rehydrates all state from Memgraph on workflow resume
- **Scoped** by `workflowId + moduleKey` for isolation

### ModuleRegistry (`core/ModuleRegistry.ts`)
Singleton factory with lazy dynamic imports, instance caching by `module::stageId`, and runtime plugin registration. Registers **50 built-in modules**: 7 composite wrappers (thin delegation layers), 32 atomic modules, 3 standalone modules, 2 provider modules, 1 SubWorkflow engine module, and 5 monolithic compatibility wrappers.

### SubWorkflowModule (`modules/core/SubWorkflowModule.ts`)
Enables workflows-within-workflows:
- Loads child workflow from `workflow` (inline JSON) or `workflowRef` (file path)
- Maps data between parent and child via `inputMap`/`outputMap`
- Shares parent's WorkflowContext (no duplicate connections)
- Recursion depth guard (default max 5)

## Module Deep Dive

### Atomic Modules — Memory Pipeline

#### SimpleMem Decomposition (6 atomic modules)

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **SlidingWindow** | SimpleMem §2 | `chunks` → `windowedChunks` |
| **DensityGate** | SimpleMem Eq.1 | `windowedChunks` → `filteredChunks` |
| **FactExtractor** | SimpleMem §2 | `filteredChunks` → `memoryUnits` |
| **SemanticSynthesis** | SimpleMem §2 | `memoryUnits` → `memoryUnits` (merged) |
| **StructuredIndex** | SimpleMem §2 | `memoryUnits` → `memoryUnits` (enriched) |
| **IntentAwarePlanner** | SimpleMem §2.3 | `query`, `memoryUnits` → `expandedQueries`, `searchScope`, `retrievalDepth` |

Sub-workflow (write path): `workflows/sub/simplemem-pipeline.json` — `Window → Gate → Extract → Synthesize → Index`
Sub-workflow (read path): `workflows/sub/simplemem-retrieval.json` — `Plan → [Sem ∥ Lex ∥ Sym] → Rank`

- **SlidingWindow**: Groups chunks into overlapping windows (configurable `windowSize`, `windowOverlap`) for temporal context.
- **DensityGate**: Implements Φ_gate(W) from the paper — LLM-based semantic density evaluation with heuristic fallback. Only windows with `≥ minFactCount` distinct facts pass through.
- **FactExtractor**: LLM de-linearisation of text into typed MemoryUnit objects with batch embedding. Supports coreference resolution via the extraction prompt.
- **SemanticSynthesis**: Cosine-based merge of highly similar units (strictly `> synthesisThreshold`, default 0.82). Averages embeddings and combines content.
- **StructuredIndex**: Multi-view indexing — enriches each unit with TF-based lexical keywords and structured symbolic metadata (type, timestamp, confidence) for complementary retrieval paths.
- **IntentAwarePlanner**: Decomposes the query into three complementary retrieval signals — `{qₛₑₘ, qₗₑₓ, qₛᵧₘ, d}` — where `d` is adaptive retrieval depth estimated from query complexity. Uses LLM with heuristic fallback.

#### LightMem Decomposition (6 atomic modules)

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **PreCompression** | LightMem §3.1 | `memoryUnits` → `memoryUnits` (compressed, redundancy removed) |
| **SensoryBuffer** | LightMem §3.1 | `memoryUnits` → `memoryUnits` (flushed when buffer ≥ th tokens, [] otherwise) |
| **NoveltyGate** | LightMem Tier 1 | `memoryUnits` → `memoryUnits` (novel only) |
| **TopicSegmenter** | LightMem §3.2 | `memoryUnits` → `topicSegments` |
| **STMBuffer** | LightMem §3.2 | `topicSegments` → `memoryUnits` (LTM-promoted summaries with topic, embedding, user/model content) |
| **SleepConsolidation** | LightMem §3.3 | `topicSegments` → `memoryUnits` (LTM) |

Sub-workflow: `workflows/sub/lightmem-pipeline.json` — `PreCompress → SensoryBuffer → [conditional: buffer full?] → NoveltyGate → TopicSegmenter → STMBuffer → SleepConsolidation`

This 7-stage pipeline implements all three tiers from the LightMem paper:
- **Light₁** (Pre-Compression + Sensory Buffer): `PreCompression` applies LLM-based cross-entropy density scoring per sentence (replaces Python-only LLMLingua-2 with an LLM approximation), retaining only sentences above the τ-percentile threshold. `SensoryBuffer` accumulates compressed units in a crash-recoverable Memgraph-backed buffer of capacity `th` tokens, flushing downstream only when full.
- **Light₂** (Novelty Gate + Topic Segmentation + STM Buffer): `NoveltyGate` cosine-filters against existing memories. `TopicSegmenter` applies hybrid B1∩B2 boundary detection — B1 = local similarity minima; B2 = threshold drops below `topicSimilarityThreshold`. `STMBuffer` accumulates topic segments and promotes to LTM format (`{topic, eᵢ := embedding(sumᵢ), userᵢ, modelᵢ}`) when capacity is reached.
- **Light₃** (Sleep Consolidation): Parallel LLM summarization of topic segments. **Soft-update LTM** semantics: `newTs >= existingTs` constraint ensures only newer information overwrites.

#### StructMem Decomposition (3 atomic modules)

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **DualPerspective** | StructMem §3.1 | `memoryUnits` → `memoryUnits` (enriched) |
| **CrossEventConsolidation** | StructMem §3.2 | `memoryUnits` → `memoryUnits` (with relations) |
| **GraphPersist** | StructMem | `memoryUnits` → (Memgraph side-effect) |

Sub-workflow: `workflows/sub/structmem-pipeline.json` — `DualPersp → Consolidate → Persist`

- **DualPerspective**: Enriches units with temporal anchoring (ISO timestamps from content) and entity extraction (named entities, event types, interactional relations). LLM-driven with regex NER fallback.
- **CrossEventConsolidation**: Full Cbuf = Sortτ pipeline — temporally sort buffer, compute aggregated query, retrieve seed entries for diversity, LLM synthesizes cross-event connections. Fallback: pairwise cosine binding with typed relation inference (CAUSAL/INVOLVES/TEMPORAL_FOLLOW).
- **GraphPersist**: Writes enriched memory units and their relations to Memgraph via parameterised queries. Configurable batch size and dry-run mode.

### Atomic Modules — HERA Agent Pipeline

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **PlanGenerator** | HERA | `query`, `retrievalResult` → `agentPlan` |
| **TrajectoryExecutor** | HERA | `query`, `agentPlan` → `trajectory` |
| **RewardComputer** | HERA | `trajectory` → `trajectory` (with reward) |
| **ExperienceReflector** | HERA | `trajectory` → `insights`, `experienceLibrary` |
| **RoPEEvolver** | HERA §3.4 | `trajectory` → `evolvedRolePrompts` |
| **TopologyMutator** | HERA §3.5 | `trajectory` → `mutatedTopology` |
| **FinalSynthesizer** | HERA | `trajectory` → `finalAnswer` |

Sub-workflow: `workflows/sub/hera-orchestration.json` — `Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize`

- **PlanGenerator**: LLM generates query-specific agent topology from available roles, informed by experience library insights and persisted topology mutations.
- **TrajectoryExecutor**: Sequential multi-agent execution with accumulated context. Uses evolved prompts (RoPE) when available, TOML role prompts as fallback. Computes composite reward inline.
- **RewardComputer**: Configurable multi-signal composite reward: retrieval quality (30%), step success rate (25%), answer completeness (25%), token efficiency (20%). Weights are tunable via config.
- **ExperienceReflector**: GRPO-style group comparison — ranks current trajectory against prior trajectories, extracts insights via LLM, updates experience library with utility-based pruning.
- **RoPEEvolver**: Identifies weakest agent (error steps or shortest output), runs contrastive LLM analysis to evolve its prompt with operational rules and behavioral principles.
- **TopologyMutator**: After `mutationTriggerCount` consecutive failures, LLM recommends structural changes (replace/augment agents). Mutations are persisted and fed into future `PlanGenerator` calls.
- **FinalSynthesizer**: LLM synthesis of accumulated agent step outputs into a polished, coherent final answer. Falls back to the last step's output if synthesis fails.

### Atomic Modules — Hybrid Retrieval

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **IntentClassifier** | LightRAG | `query` → `searchScope` |
| **VectorSearch** | LightRAG | `query` → `candidates` (appends) |
| **GraphSearch** | LightRAG | `query` → `candidates` (appends) |
| **KeywordSearch** | LightRAG | `query` → `candidates` (appends) |
| **ResultRanker** | LightRAG | `candidates` → `retrievalResult` |

Sub-workflow: `workflows/sub/hybrid-retrieval.json` — `Intent → [Vector ∥ Graph ∥ Keyword] → Rank`

The 3-way parallel search fan-out is now **visible in JSON** instead of hidden in imperative code. Each search strategy has independent weight and topK configuration. ResultRanker handles dedup, scoring, pyramid expansion with budget gating, and MemoryUnit retrieval.

#### SimpleMem Multi-View Retrieval (2 additional atomic modules)

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **IntentAwarePlanner** | SimpleMem §2.3 | `query`, `memoryUnits` → `expandedQueries`, `semanticQuery`, `lexicalQuery`, `symbolicFilter`, `retrievalDepth` |
| **SymbolicSearch** | SimpleMem §2.1 | `query`, `symbolicFilter`, `memoryUnits` → `candidates` (appended with source="symbolic") |

Sub-workflow: `workflows/sub/simplemem-retrieval.json` — `Plan → [Sem ∥ Lex ∥ Sym] → Rank`

- **IntentAwarePlanner**: Uses LLM reasoning to decompose the query into three complementary retrieval signals (`qₛₑₘ`, `qₗₑₓ`, `qₛᵧₘ`) and estimate adaptive retrieval depth `d`. Outputs: individual queries per channel + combined `expandedQueries` array + `retrievalDepth`.
- **SymbolicSearch**: Queries memory units by structured metadata constraints (type, entities, time range, confidence) produced by `StructuredIndex`. Supports Memgraph-backed retrieval with in-memory filtering fallback.

### Atomic Modules — Graph Indexing

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **ChunkIngestor** | LightRAG §3.1 | `chunks`, `embeddings` → `:Chunk` nodes |
| **EntityExtractor** | LightRAG §3.1 | `chunks` → `entities`, `relationships` |
| **EntityDeduplicator** | LightRAG §3.1 | `entities` → `entities` (canonical) |
| **EntityProfiler** | LightRAG §3.1 | `entities`, `chunks` → profile summaries |
| **CommunityDetector** | LightRAG | (graph state) → community labels |

Sub-workflow: `workflows/sub/graph-indexing.json` — `Ingest → Extract → Dedup → Profile → Community`

### Atomic Modules — PriHA Generation

| Module | Paper Ref | Reads → Writes |
|---|---|---|
| **QueryClarifier** | PriHA (PHC-O) | `query` → `query` (refined), `clarifications` |
| **AnswerGenerator** | PriHA | `query`, `retrievalResult` → `finalAnswer` |
| **HallucinationValidator** | PriHA | `finalAnswer` → `finalAnswer` (validated) |
| **CitationInjector** | PriHA | `finalAnswer`, `sources` → `finalAnswer` (cited) |

Sub-workflow: `workflows/sub/priha-fusion.json` — `Clarify → Generate → Validate → Cite`

### S2Chunker (`modules/chunking/S2Chunker.ts`)
- **Paper**: S2 Chunking (arXiv:2501.05485)
- Real spectral clustering: affinity matrix → normalised Laplacian → Jacobi eigensolver → eigengap heuristic for k → K-Means++ on eigenvectors
- Extends `TextSplitter` from `@langchain/textsplitters`
- L2-normalised embeddings, reading-order reconstruction
- **Deviation from paper**: combined weight formula uses configurable `alpha` parameter (default 0.5) instead of the paper's fixed average: `w = alpha * w_semantic + (1 - alpha) * w_spatial`.
- Companion: `MarkdownSpatialParser` (367L) converts Markdown → spatial elements

### QueryTranslator (`modules/query/QueryTranslatorModule.ts`)
- HyDE, Multi-Query, Step-Back, Query Rewriting, Intent Clarification
- Real LLM calls with string-template fallbacks

## Data Model in Memgraph

- **:Chunk** — S2 output (text, embedding, source)
- **:MemoryUnit** — atomic facts/events/summaries (content, embedding, type, timestamp, confidence)
- **:Entity** — LLM-extracted entities with type, description, profileSummary, keyThemes
- **:Element** — raw layout elements from document parser
- **:ModuleState** — persistent module state (workflowId, moduleKey, value JSON, updatedAt)
- **Edges**: `SPATIAL_NEAR`, `MEMORY_RELATION`, `MENTIONS`, `RELATES_TO` (typed relationships with description + keywords)
- **Indexes**: Vector on `Chunk.embedding`, `MemoryUnit.embedding`

## HTTP API (Hono)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Service health + registered modules |
| `/modules` | GET | List available modules |
| `/workflow/run` | POST | Execute workflow from JSON config + input |

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
| Generation | `finalAnswer`, `sources`, `confidence` |
| Meta | `metrics`, `[key: string]: unknown` (escape hatch) |

## Error Handling

7 typed error classes: `MemFlowError`, `WorkflowStageError`, `WorkflowConfigError`, `WorkflowDAGError`, `ModuleNotFoundError`, `ProviderError`, `MemgraphError`.

## Security & Production Notes

- No external code execution in workflow JSON
- All Cypher query values use parameterised bindings (no string interpolation of user data); label/property identifiers are validated against a strict `^[A-Za-z_][A-Za-z0-9_]{0,63}$` allowlist before interpolation (required because Cypher does not support parameterised labels). DDL statements (CREATE INDEX) also interpolate `dimensions` which is validated as a safe positive integer (1–65536) via `assertSafeDimension()`.
- API keys via env only
- Memgraph auth + network isolation recommended in prod
- CORS middleware on HTTP server
- **Dual-runtime**: Server auto-detects Bun vs Node.js via `globalThis.Bun`. Bun uses native `Bun.serve()`, Node.js uses `@hono/node-server` (listed in dependencies) with raw `node:http` fallback.

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
    ModuleRegistry.ts          — Lazy-loading singleton with 50 registered modules
    StateStore.ts              — Memgraph-backed persistent state with LRU cache
    types.ts                   — All interfaces (WorkflowData, BaseModule, etc.)
    errors.ts                  — 7 typed error classes
  modules/
    core/                      SubWorkflowModule
    chunking/                  S2ChunkerModule, MarkdownSpatialParserModule
    memory/                    SimpleMemModule, LightMemModule, StructMemModule,
                               SlidingWindowModule, DensityGateModule, FactExtractorModule,
                               SemanticSynthesisModule, NoveltyGateModule, TopicSegmenterModule,
                               SleepConsolidationModule, DualPerspectiveModule,
                               CrossEventConsolidationModule, GraphPersistModule,
                               StructuredIndexModule, PreCompressionModule, SensoryBufferModule,
                               STMBufferModule, IntentAwarePlannerModule
    agents/                    HERAOrchestratorModule, PlanGeneratorModule, TrajectoryExecutorModule,
                               RewardComputerModule, ExperienceReflectorModule,
                               RoPEEvolverModule, TopologyMutatorModule
    retrieval/                 LightRAGRetrieverModule, IntentClassifierModule, VectorSearchModule,
                               GraphSearchModule, KeywordSearchModule, ResultRankerModule,
                               SymbolicSearchModule
    graph/                     MemgraphGraphModule, ChunkIngestorModule, EntityExtractorModule,
                               EntityDeduplicatorModule, EntityProfilerModule, CommunityDetectorModule
    generation/                PriHAFusionModule, QueryClarifierModule, AnswerGeneratorModule,
                               HallucinationValidatorModule, CitationInjectorModule
    query/                     QueryTranslatorModule
    providers/                 EmbedderModule, LLMProviderModule
  workflows/
    examples/                  rag-memory-pipeline.json, quick-qa.json, multi-agent-research.json
    sub/                       simplemem-pipeline.json, simplemem-retrieval.json,
                               lightmem-pipeline.json, structmem-pipeline.json,
                               hera-orchestration.json, hybrid-retrieval.json, graph-indexing.json,
                               priha-fusion.json
  prompts/                     TOML prompt templates (see Prompt System section)
  providers/                   LLMProvider.ts, EmbeddingProvider.ts, MemgraphClient.ts
  server/                      Hono HTTP server (dual-runtime Bun/Node.js)
  utils/                       promptLoader.ts, similarity.ts, tokens.ts
```

---

*Every module is traceable to a specific paper. See [PAPERS.md](docs/PAPERS.md) for the full reference list.*