# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It decomposes complex RAG capabilities into **25 atomic modules** — each independently consumable — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience.

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
  ├── ModuleRegistry (38 modules: 12 monolithic + 25 atomic + 1 SubWorkflow)
  ├── StateStore (Memgraph-backed, crash-recoverable, in-memory LRU cache)
  └── Stages → Module.process() → shared WorkflowData bus
        └── SubWorkflow stages → nested WorkflowEngine (shared context)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Module Inventory

### Atomic Modules (25)

| Category | Modules | Paper |
|---|---|---|
| **Memory** | `SlidingWindow`, `DensityGate`, `FactExtractor`, `SemanticSynthesis` | SimpleMem |
| **Memory** | `NoveltyGate`, `TopicSegmenter`, `SleepConsolidation` | LightMem |
| **Memory** | `DualPerspective`, `CrossEventConsolidation`, `GraphPersist` | StructMem |
| **Agents** | `PlanGenerator`, `TrajectoryExecutor`, `RewardComputer`, `ExperienceReflector`, `RoPEEvolver`, `TopologyMutator` | HERA |
| **Retrieval** | `IntentClassifier`, `VectorSearch`, `GraphSearch`, `KeywordSearch`, `ResultRanker` | LightRAG |
| **Graph** | `ChunkIngestor`, `EntityExtractor`, `EntityDeduplicator`, `EntityProfiler`, `CommunityDetector` | LightRAG |
| **Generation** | `QueryClarifier`, `AnswerGenerator`, `HallucinationValidator`, `CitationInjector` | PriHA |

### Composite Modules (backward-compatible wrappers)

| Module | Paper | What it does |
|---|---|---|
| **S2Chunker** | [S2 Chunking](https://arxiv.org/abs/2501.05485) | Real spectral clustering on spatial+semantic affinity. Extends LangChain `TextSplitter`. |
| **SimpleMem** | [SimpleMem](https://arxiv.org/abs/2601.02553) | LLM-driven fact extraction + online semantic synthesis |
| **LightMem** | [LightMem](https://arxiv.org/abs/2510.18866) | Novelty gating + B1∩B2 topic segmentation + sleep-time consolidation |
| **StructMem** | [StructMem](https://arxiv.org/abs/2604.21748) | Dual-perspective event binding + temporal relations + graph persistence |
| **LightRAGRetriever** | [LightRAG](https://arxiv.org/abs/2410.05779) | Hybrid vector+graph+keyword retrieval with intent-aware planning |
| **HERAOrchestrator** | [HERA](https://arxiv.org/abs/2604.00901) | Multi-agent orchestration with GRPO evolution + RoPE + topology mutation |
| **PriHAFusion** | [PriHA](https://arxiv.org/abs/2604.14215) | Query triage + dual-source fusion + hallucination validation + citations |
| **QueryTranslator** | — | HyDE, Multi-Query, Step-Back, Rewriting, Intent Clarification |
| **MarkdownSpatialParser** | — | Markdown → spatial elements (heading hierarchy, code fences) |

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