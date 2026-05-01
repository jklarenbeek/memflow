# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a modular, JSON-driven workflow engine with built-in learning loops. It combines real spectral chunking, multi-tier memory systems, hybrid retrieval, multi-agent orchestration, and hallucination validation — all backed by Memgraph for graph-native persistence.

## Quick Start

```bash
# Install
bun install

# Start the HTTP server (requires Memgraph on bolt://localhost:7687)
bun run start

# Or run a workflow directly
bun src/index.ts run src/workflows/examples/rag-memory-pipeline.json --input='{"query": "What is S2 chunking?"}'
```

## Features

| Module | Paper | What it does |
|---|---|---|
| **S2Chunker** | [S2 Chunking](https://arxiv.org/abs/2501.05485) | Real spectral clustering on spatial+semantic affinity. Extends LangChain `TextSplitter`. |
| **SimpleMem** | [SimpleMem](https://arxiv.org/abs/2601.02553) | LLM-driven atomic fact extraction + online semantic synthesis |
| **LightMem** | [LightMem](https://arxiv.org/abs/2510.18866) | Novelty gating + sleep-time consolidation (dedup + LLM abstraction) |
| **StructMem** | [StructMem](https://arxiv.org/abs/2604.21748) | Dual-perspective event binding + temporal relations + graph persistence |
| **LightRAGRetriever** | [LightRAG](https://arxiv.org/abs/2410.05779) | Hybrid vector+graph+keyword retrieval with intent-aware planning + pyramid expansion |
| **HERAOrchestrator** | [HERA](https://arxiv.org/abs/2604.00901) | Multi-agent orchestration with experience library + GRPO-style evolution |
| **PriHAFusion** | [PriHA](https://arxiv.org/abs/2604.14215) | Query triage + dual-source fusion + hallucination validation + citations |
| **QueryTranslator** | [5 Techniques](https://towardsdatascience.com/) | HyDE, Multi-Query, Step-Back, Rewriting, Intent Clarification |
| **MarkdownSpatialParser** | — | Markdown → spatial elements (heading hierarchy, code fences, reading order) |
| **Learning Loop** | [AutoResearchClaw](https://github.com/aiming-lab/AutoResearchClaw) | Self-evolving config: composite scoring → config mutation across iterations |

## Architecture

```
WorkflowEngine ← JSON config
  ├── WorkflowContext (DI: MemgraphClient, LLM, Embeddings, Logger)
  ├── ModuleRegistry (lazy loading, instance caching, plugin registration)
  └── Stages → Module.process() → shared WorkflowData bus
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

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