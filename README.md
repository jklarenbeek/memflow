# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It decomposes complex RAG capabilities into **38 atomic modules** — each independently consumable — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience.

### v0.3.0 Highlights

- **Batch Memgraph operations** — `UNWIND`-based batch queries reduce graph write round-trips by 10-50×
- **Structured telemetry** — per-module `tokenUsage`, `memgraphQueries`, `embeddingCalls` counters aggregated in API responses
- **Configurable similarity** — strategy pattern (`cosine`, `euclidean`, `dotProduct`) across all similarity-dependent modules
- **Config validation at load time** — Zod schema validation during `initialize()` catches errors before execution
- **Proper error boundaries** — bare `catch {}` blocks replaced with structured logging across 15+ modules

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
  ├── ModuleRegistry (56 modules: 7 composite wrappers + 38 atomic + 3 standalone + 2 providers + 2 core + 4 monolithic compat)
  ├── StateStore (Memgraph-backed, crash-recoverable, in-memory LRU cache)
  ├── Config Validation (Zod schemas validated at initialize(), not mid-pipeline)
  └── Stages → Module.process() → shared WorkflowData bus (with telemetry counters)
        ├── SubWorkflow stages → nested WorkflowEngine (shared context)
        └── MemgraphClient.batchQuery() → UNWIND-based batch operations
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Module Inventory

MemFlow registers **56 modules** across 10 categories:

| Category | Count | Key Modules |
|---|---|---|
| Core | 2 | `SubWorkflow`, `AutonomousLoop` |
| Chunking | 3 | `S2Chunker`, `MarkdownSpatialParser`, `ParentChildChunker` |
| Memory | 16 | SimpleMem (6), LightMem (7 incl. `AttentionScore`), StructMem (3) |
| Retrieval | 9 | `IntentClassifier`, `VectorSearch`, `GraphSearch`, `KeywordSearch`, `ResultRanker`, `SymbolicSearch`, `SetUnionMerger`, `DualLevelRouter` + wrapper |
| Agents | 8 | `PlanGenerator`, `TrajectoryExecutor`, `RewardComputer`, `ExperienceReflector`, `RoPEEvolver`, `TopologyMutator`, `FinalSynthesizer` + wrapper |
| Graph | 6 | `ChunkIngestor`, `EntityExtractor`, `EntityDeduplicator`, `EntityProfiler`, `CommunityDetector` + wrapper |
| Generation | 6 | `QueryClarifier`, `AnswerGenerator`, `HallucinationValidator`, `CitationInjector`, `WebSearchAgent` (stub) + wrapper |
| Query | 1 | `QueryTranslator` |
| Providers | 2 | `Embedder`, `LLMProvider` |
| Compat | 3 | `SimpleMem`, `LightMem`, `StructMem` (monolithic wrappers) |

> **Full module reference** with input/output fingerprints, config schemas, and paper traceability: **[docs/modules/MODULES.md](docs/modules/MODULES.md)**
>
> **Improvement roadmap**: **[docs/modules/IMPROVE.md](docs/modules/IMPROVE.md)**

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

The `/workflow/run` response includes aggregated telemetry:

```json
{
  "success": true,
  "workflowId": "...",
  "data": { "finalAnswer": "...", "confidence": 0.92, "sources": [...] },
  "telemetry": {
    "tokenUsage": 4200,
    "memgraphQueries": 12,
    "embeddingCalls": 3
  }
}

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