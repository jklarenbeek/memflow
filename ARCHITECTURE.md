# MemFlow Architecture

> Self-Improving RAG & Lifelong Memory Workflow Engine

---

## Design Philosophy

MemFlow is **modular, typed, and self-improving**:

- Every major capability from 10+ research papers (2024–2026) is an independent, testable module.
- Modules communicate through a **typed shared data bus** (`WorkflowData`), not `Record<string, any>`.
- The **WorkflowEngine** reads a JSON file and executes stages with retry, validation, and an optional learning loop.
- **WorkflowContext** provides dependency injection — shared Memgraph client, cached LLM/Embedding providers with per-module overrides, and Winston structured logging.
- **Memgraph + MAGE** is the persistence layer for graphs, vectors, and memory units.
- S2Chunker extends LangChain's **real `TextSplitter`** class — drop-in compatible with any LCEL pipeline.

## High-Level Architecture

```mermaid
graph TD
    JSON["Workflow JSON"] --> WE["WorkflowEngine"]
    WE --> CTX["WorkflowContext (DI)"]
    CTX --> MG["MemgraphClient"]
    CTX --> LLM["LLM Provider"]
    CTX --> EMB["Embedding Provider"]
    CTX --> LOG["Winston Logger"]
    
    WE --> MR["ModuleRegistry"]
    MR --> QT["QueryTranslator"]
    MR --> S2["S2Chunker"]
    MR --> MSP["MarkdownSpatialParser"]
    MR --> SM["SimpleMem"]
    MR --> LM["LightMem"]
    MR --> STM["StructMem"]
    MR --> LR["LightRAGRetriever"]
    MR --> HERA["HERAOrchestrator"]
    MR --> PH["PriHAFusion"]
    MR --> EMMOD["Embedder"]
    MR --> LLMOD["LLMProvider"]
    MR --> MGMOD["MemgraphGraph"]
    
    WE -->|"learning loop"| WE
    WE --> API["Hono HTTP Server"]
```

## Core Runtime

### WorkflowEngine (`core/WorkflowEngine.ts`)
1. Parse JSON config → validate with Zod
2. `initialize()` → create WorkflowContext, resolve modules, call `init()`
3. `run()` → execute DAG with retry, trace, and optional learning iterations
4. `shutdown()` → call `shutdown()` on all modules and context

Features:
- **Parallel DAG execution**: when `next` is an array, branches execute concurrently via `Promise.allSettled`. The `dependsOn` field gates execution until all listed dependencies complete. `maxConcurrency` in `globalConfig` limits parallel width.
- **Configurable conditional routing**: `next` can be `{ "metric>threshold": "stageId", "default": "fallback" }` with operators `>`, `>=`, `<`, `<=`, `==`, `!=`. Bare metric names default to `> 0.5` for backward compatibility.
- Exponential backoff retry per stage
- Learning loop with composite scoring
- State export as JSON

### WorkflowContext (`core/WorkflowContext.ts`)
DI container holding all shared runtime resources:
- **MemgraphClient** — singleton, parameterised Cypher only
- **LLM providers** — cached by `provider:model` key, per-module override
- **Embedding providers** — same caching strategy
- **Winston logger** — structured JSON logging
- **Trace accumulator** — per-stage timing and I/O summaries

### ModuleRegistry (`core/ModuleRegistry.ts`)
Singleton factory with lazy dynamic imports, instance caching by `module::stageId`, and runtime plugin registration.

## Module Deep Dive

### S2Chunker (`modules/chunking/S2Chunker.ts`)
- **Paper**: S2 Chunking (arXiv:2501.05485)
- Real spectral clustering: affinity matrix → normalised Laplacian → Jacobi eigensolver → eigengap heuristic for k → K-Means++ on eigenvectors
- Extends `TextSplitter` from `@langchain/textsplitters`
- L2-normalised embeddings, reading-order reconstruction
- **Deviation from paper**: combined weight formula uses configurable `alpha` parameter (default 0.5) instead of the paper's fixed average: `w = alpha * w_semantic + (1 - alpha) * w_spatial`. This allows tuning the spatial-vs-semantic balance per dataset.
- Companion: `MarkdownSpatialParser` (367L) converts Markdown → spatial elements

### Memory Pipeline (SimpleMem → LightMem → StructMem)
- **SimpleMem**: LLM de-linearisation (atomic fact extraction, coreference resolution) + online semantic synthesis (merge > 0.82 strictly greater than, not ≥) + sliding window grouping (overlapping windows for temporal context) + multi-view structured indexing (semantic/lexical/symbolic layers)
- **LightMem**: Three-tier hierarchical memory (Sensory → STM → LTM). Sensory buffer filters by novelty gating (cosine threshold). Topic segmentation detects topic boundaries via similarity drops between adjacent units. STM accumulates topic-segmented units with capacity triggers. LTM stores sleep-time consolidated abstractions via parallel LLM summarization.
- **StructMem**: Dual-perspective event binding + temporal anchoring + buffered cross-event consolidation (Cbuf = Sortτ{x ∈ Mbuffer}). Events accumulate in an internal buffer; consolidation triggers when buffer exceeds size threshold or time since last consolidation exceeds interval. Persists to Memgraph.

### LightRAGRetriever (`modules/retrieval/LightRAGRetrieverModule.ts`)
- **Paper**: LightRAG (arXiv:2410.05779)
- Hybrid: vector search + graph traversal + keyword fulltext
- Intent-aware planning: LLM classifies query type → adjusts search scope
- Pyramid progressive expansion: budget-gated, with graph neighbour fallback on low recall
- Note: incremental graph updates are handled by `MemgraphGraph` module, not the retriever

### HERAOrchestrator (`modules/agents/HERAOrchestratorModule.ts`)
- **Paper**: HERA (arXiv:2604.00901)
- Experience Library: Profile-Insight-Utility tuples, reinforced via GRPO-style group comparison
- LLM-generated agent topologies (retriever/reasoner/critic/synthesizer/verifier/decomposer)
- Multi-agent trajectory execution with accumulated context
- **RoPE (Role-aware Prompt Evolution, §3.4)**: Tracks per-agent failed trajectories. Contrastive analysis extracts operational rules (short-term corrections) + behavioral principles (long-term strategies). Evolved prompts are consolidated and used in subsequent trajectory executions.
- **Topology Mutation (§3.5)**: When trajectories consistently fail below `mutationThreshold` for `mutationTriggerCount` consecutive runs, the orchestrator replaces failing agents or augments the topology with alternatives.

### PriHAFusion (`modules/generation/PriHAFusionModule.ts`)
- **Paper**: PriHA (arXiv:2604.14215)
- Automated multi-query clarification (PHC-O pattern): iteratively decomposes fuzzy queries into specific sub-queries (up to `maxClarificationDepth` passes), dual-source fusion (guidelines vs dynamic context), hallucination validation, inline citations

### QueryTranslator (`modules/query/QueryTranslatorModule.ts`)
- HyDE, Multi-Query, Step-Back, Query Rewriting, Intent Clarification
- Real LLM calls with string-template fallbacks

## Data Model in Memgraph

- **:Chunk** — S2 output (text, embedding, source)
- **:MemoryUnit** — atomic facts/events/summaries (content, embedding, type, timestamp, confidence)
- **:Entity** — extracted from memory pipeline
- **:Element** — raw layout elements from document parser
- **Edges**: `SPATIAL_NEAR`, `MEMORY_RELATION`, `MENTIONS`
- **Indexes**: Vector on `Chunk.embedding`, `MemoryUnit.embedding`

## HTTP API (Hono)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Service health + registered modules |
| `/modules` | GET | List available modules |
| `/workflow/run` | POST | Execute workflow from JSON config + input |

## Type Safety

The `WorkflowData` interface provides typed fields for all inter-module data:
- `query`, `expandedQueries` — query stage
- `documents`, `chunks`, `embeddings` — chunking/embedding stage
- `memoryUnits` — memory stage
- `retrievalResult` — retrieval stage
- `agentResult`, `finalAnswer`, `sources`, `confidence` — generation stage
- `metrics` — accumulated across all stages
- `[key: string]: unknown` — escape hatch for custom extensions

## Error Handling

7 typed error classes: `MemFlowError`, `WorkflowStageError`, `WorkflowConfigError`, `WorkflowDAGError`, `ModuleNotFoundError`, `ProviderError`, `MemgraphError`.

## Security & Production Notes

- No external code execution in workflow JSON
- All Cypher query values use parameterised bindings (no string interpolation of user data); label/property identifiers are validated against a strict `^[A-Za-z_][A-Za-z0-9_]{0,63}$` allowlist before interpolation (required because Cypher does not support parameterised labels). DDL statements (CREATE INDEX) also interpolate `dimensions` which is validated as a safe positive integer (1–65536) via `assertSafeDimension()`.
- API keys via env only
- Memgraph auth + network isolation recommended in prod
- CORS middleware on HTTP server
- **Dual-runtime**: Server auto-detects Bun vs Node.js via `globalThis.Bun`. Bun uses native `Bun.serve()`, Node.js uses `@hono/node-server` with raw `node:http` fallback.

## Workflow Examples

Three example workflows in `src/workflows/examples/`:
- `rag-memory-pipeline.json` — Full 10-stage pipeline: translate → parse → chunk → embed → graph → SimpleMem → LightMem → StructMem → retrieve → fuse
- `quick-qa.json` — Minimal 4-stage QA: translate → embed → retrieve → fuse
- `multi-agent-research.json` — Advanced: parallel retrieval branches → HERA with learning + RoPE + topology mutation

---

*Every module is traceable to a specific paper. See [PAPERS.md](docs/PAPERS.md) for the full reference list.*