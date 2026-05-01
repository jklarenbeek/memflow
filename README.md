# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It decomposes complex RAG capabilities into **27 atomic modules** — each independently consumable — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience.

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
  ├── ModuleRegistry (40 modules: 12 delegation wrappers + 27 atomic + 1 SubWorkflow)
  ├── StateStore (Memgraph-backed, crash-recoverable, in-memory LRU cache)
  └── Stages → Module.process() → shared WorkflowData bus
        └── SubWorkflow stages → nested WorkflowEngine (shared context)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Module Inventory

### Atomic Modules (27)

| Category | Modules | Paper |
|---|---|---|
| **Memory** | `SlidingWindow`, `DensityGate`, `FactExtractor`, `SemanticSynthesis`, `StructuredIndex` | SimpleMem |
| **Memory** | `NoveltyGate`, `TopicSegmenter`, `SleepConsolidation` | LightMem |
| **Memory** | `DualPerspective`, `CrossEventConsolidation`, `GraphPersist` | StructMem |
| **Agents** | `PlanGenerator`, `TrajectoryExecutor`, `RewardComputer`, `ExperienceReflector`, `RoPEEvolver`, `TopologyMutator`, `FinalSynthesizer` | HERA |
| **Retrieval** | `IntentClassifier`, `VectorSearch`, `GraphSearch`, `KeywordSearch`, `ResultRanker` | LightRAG |
| **Graph** | `ChunkIngestor`, `EntityExtractor`, `EntityDeduplicator`, `EntityProfiler`, `CommunityDetector` | LightRAG |
| **Generation** | `QueryClarifier`, `AnswerGenerator`, `HallucinationValidator`, `CitationInjector` | PriHA |

### Composite Modules (delegation wrappers)

These modules preserve backward compatibility by maintaining the original API surface while delegating all algorithmic logic to their respective atomic sub-workflows via `SubWorkflowModule`.

| Module | Sub-Workflow | Pipeline |
|---|---|---|
| **S2Chunker** | — (standalone) | Real spectral clustering on spatial+semantic affinity |
| **SimpleMem** | `simplemem-pipeline.json` | Window → Gate → Extract → Synthesize → Index |
| **LightMem** | `lightmem-pipeline.json` | NoveltyGate → TopicSegmenter → SleepConsolidation |
| **StructMem** | `structmem-pipeline.json` | DualPerspective → CrossEventConsolidation → GraphPersist |
| **LightRAGRetriever** | `hybrid-retrieval.json` | IntentClassifier → [Vector ∥ Graph ∥ Keyword] → ResultRanker |
| **HERAOrchestrator** | `hera-orchestration.json` | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize |
| **PriHAFusion** | `priha-fusion.json` | Clarify → Generate → Validate → Cite |
| **MemgraphGraph** | `graph-indexing.json` | Ingest → Extract → Dedup → Profile → Communities |
| **QueryTranslator** | — (standalone) | HyDE, Multi-Query, Step-Back, Rewriting |
| **MarkdownSpatialParser** | — (standalone) | Markdown → spatial elements |

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
| `simplemem-pipeline.json` | Window → Gate → Extract → Synthesize | Full SimpleMem §2 |
| `lightmem-pipeline.json` | Novelty → Segment → Consolidate | Three-tier memory with B1∩B2 |
| `structmem-pipeline.json` | DualPersp → Consolidate → Persist | Cbuf→seed→LLM synthesis |
| `hera-orchestration.json` | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] | Conditional branches |
| `hybrid-retrieval.json` | Intent → [Vector ∥ Graph ∥ Keyword] → Rank | 3-way parallel search |
| `graph-indexing.json` | Ingest → Extract → Dedup → Profile → Community | LightRAG §3.1 |
| `priha-fusion.json` | Clarify → Generate → Validate → Cite | Full PriHA pipeline |

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