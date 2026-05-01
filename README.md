# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It decomposes complex RAG capabilities into **32 atomic modules** — each independently consumable — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience.

## Quick Start

```bash
# Install
bun install

# Start the HTTP server (requires Memgraph on bolt://localhost:7687)
bun run start

# Or run a workflow directly
bun src/index.ts run src/workflows/examples/rag-memory-pipeline.json --input='{"query": "What is S2 chunking?"}'
```

## Architecture

MemFlow's core innovation is **composable sub-workflows**: complex capabilities (HERA orchestration, hybrid retrieval, memory pipelines) are described as JSON DAGs of atomic modules, callable from parent workflows via the `SubWorkflow` engine module.

```
WorkflowEngine ← JSON config
  ├── WorkflowContext (DI: MemgraphClient, StateStore, LLM, Embeddings, Logger)
  ├── ModuleRegistry (50 modules: 7 composite wrappers + 32 atomic + 3 standalone + 2 providers + 1 SubWorkflow + 5 monolithic compat)
  ├── StateStore (Memgraph-backed, crash-recoverable, in-memory LRU cache)
  └── Stages → Module.process() → shared WorkflowData bus
        └── SubWorkflow stages → nested WorkflowEngine (shared context)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Module Inventory

### Atomic Modules (32)

| Category | Modules | Paper |
|---|---|---|
| **Memory** | `SlidingWindow`, `DensityGate`, `FactExtractor`, `SemanticSynthesis`, `StructuredIndex` | SimpleMem |
| **Memory** | `IntentAwarePlanner` | SimpleMem §2.3 |
| **Memory** | `PreCompression`, `SensoryBuffer`, `STMBuffer` | LightMem §3.1–3.2 |
| **Memory** | `NoveltyGate`, `TopicSegmenter`, `SleepConsolidation` | LightMem |
| **Memory** | `DualPerspective`, `CrossEventConsolidation`, `GraphPersist` | StructMem |
| **Agents** | `PlanGenerator`, `TrajectoryExecutor`, `RewardComputer`, `ExperienceReflector`, `RoPEEvolver`, `TopologyMutator`, `FinalSynthesizer` | HERA |
| **Retrieval** | `IntentClassifier`, `VectorSearch`, `GraphSearch`, `KeywordSearch`, `ResultRanker`, `SymbolicSearch` | LightRAG / SimpleMem |
| **Graph** | `ChunkIngestor`, `EntityExtractor`, `EntityDeduplicator`, `EntityProfiler`, `CommunityDetector` | LightRAG |
| **Generation** | `QueryClarifier`, `AnswerGenerator`, `HallucinationValidator`, `CitationInjector` | PriHA |

### Composite Modules (7 delegation wrappers)

These modules preserve backward compatibility by maintaining the original API surface while delegating all algorithmic logic to their respective atomic sub-workflows via `SubWorkflowModule`.

| Module | Sub-Workflow | Pipeline |
|---|---|---|
| **SimpleMem** | `simplemem-pipeline.json` | Window → Gate → Extract → Synthesize → Index |
| **LightMem** | `lightmem-pipeline.json` | PreCompress → SensoryBuffer → [conditional] → NoveltyGate → TopicSegmenter → STMBuffer → SleepConsolidation |
| **StructMem** | `structmem-pipeline.json` | DualPerspective → CrossEventConsolidation → GraphPersist |
| **LightRAGRetriever** | `hybrid-retrieval.json` | IntentClassifier → [Vector ∥ Graph ∥ Keyword] → ResultRanker |
| **HERAOrchestrator** | `hera-orchestration.json` | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize |
| **PriHAFusion** | `priha-fusion.json` | Clarify → Generate → Validate → Cite |
| **MemgraphGraph** | `graph-indexing.json` | Ingest → Extract → Dedup → Profile → Communities |

### Standalone Modules (3)

| Module | Purpose |
|---|---|
| **S2Chunker** | Real spectral clustering on spatial+semantic affinity (extends LangChain TextSplitter) |
| **QueryTranslator** | HyDE, Multi-Query, Step-Back, Rewriting |
| **MarkdownSpatialParser** | Markdown → spatial elements |

### Infrastructure

| Module | Purpose |
|---|---|
| **SubWorkflow** | Execute a child workflow as a single stage (workflows-within-workflows) |
| **Embedder** | LangChain embedding provider (Ollama / OpenAI / OpenRouter) |
| **LLMProvider** | LangChain chat model provider (Ollama / OpenAI / OpenRouter) |
| **MemgraphGraph** | Graph indexing: chunk ingestion, entity extraction, deduplication, profiling, community detection |

## Sub-Workflows

Pre-built sub-workflow JSONs compose atomic modules into paper-aligned pipelines:

| Sub-Workflow | Stages | Highlights |
|---|---|---|
| `simplemem-pipeline.json` | Window → Gate → Extract → Synthesize → Index | Full SimpleMem §2 write path |
| `simplemem-retrieval.json` | Plan → [Sem ∥ Lex ∥ Sym] → Rank | SimpleMem §2.3 multi-view retrieval |
| `lightmem-pipeline.json` | PreCompress → SensoryBuffer → [cond] → Novelty → Segment → STMBuffer → Consolidate | Full LightMem 3-tier (Light₁+Light₂+Light₃) |
| `structmem-pipeline.json` | DualPersp → Consolidate → Persist | Cbuf→seed→LLM synthesis |
| `hera-orchestration.json` | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize | Conditional GRPO branches |
| `hybrid-retrieval.json` | Intent → [Vector ∥ Graph ∥ Keyword] → Rank | 3-way parallel search |
| `graph-indexing.json` | Ingest → Extract → Dedup → Profile → Community | LightRAG §3.1 |
| `priha-fusion.json` | Clarify → Generate → Validate → Cite | Full PriHA pipeline |

> **Note**: The PriHA Reconciler module (CLocal + CWeb fusion with priority rules and conflict resolution, per PriHA §3.3) is not yet implemented because it depends on the **Web Search Agent** (`WebSearchAgent`), which is currently a stub awaiting a search API provider integration. When the WSA is completed, the Reconciler will fuse local and web retrieval results with source priority, temporal freshness scoring, and conflict resolution. The `WebSearchAgent` stub is registered and available for development against its output contract.

### Additional Retrieval Module

| Module | Paper | Purpose |
|---|---|---|
| **SetUnionMerger** | OMNI-SIMPLEMEM §4.2 | Set-union deduplication of multi-channel candidates (alternative to score-based `ResultRanker`) |

## API

```bash
# Health check
curl http://localhost:3000/health

# List modules
curl http://localhost:3000/modules

# Run a workflow
curl -X POST http://localhost:3000/workflow/run \
  -H "Content-Type: application/json" \
  -d '{"workflow": {...}, "input": {"query": "..."}}'
```

## Docker

```bash
# Build and run (includes Memgraph)
docker compose -f docker/docker-compose.yml up -d
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` / `openrouter` / `openai` |
| `LLM_MODEL` | `llama3.2` | Model name |
| `EMBEDDING_PROVIDER` | `ollama` | Same as LLM |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `MEMGRAPH_URI` | `bolt://localhost:7687` | Memgraph connection |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Testing

```bash
bun test
```

Tests use a shared mock factory (`src/tests/helpers/mocks.ts`) that provides configurable mocks for WorkflowContext, LLM, Embeddings, and MemgraphClient — no external services required.

## License

MIT