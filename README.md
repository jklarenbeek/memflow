# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It decomposes complex RAG capabilities into **38 atomic modules** — each independently consumable — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience.

### v0.4.0 Highlights

- **TOML prompt validation at startup** — `validateAllPrompts()` checks all 25+ prompt references during `WorkflowContext.create()`, surfacing missing templates before execution
- **Community-aware graph search** — `GraphSearch` leverages `:Community` summaries for high-level/exploratory queries, scoping traversal by community membership
- **Configurable similarity completed** — `CrossEventConsolidation` and `SleepConsolidation` now support the `similarityFunction` strategy pattern (all 5 modules covered)
- **Hot-reload for TOML prompts** — `fs.watch`-based watcher + `POST /prompts/reload` endpoint eliminates server restarts during prompt engineering
- **Workflow versioning** — `SUPPORTED_VERSIONS` compatibility checks reject unsupported versions and warn on deprecated ones
- **SSE streaming** — `POST /workflow/run/stream` endpoint streams stage-level progress events and token-by-token LLM output via Server-Sent Events

### v0.3.0 Highlights

- **Batch Memgraph operations** — `UNWIND`-based batch queries reduce graph write round-trips by 10-50×
- **Structured telemetry** — per-module `tokenUsage`, `memgraphQueries`, `embeddingCalls` counters aggregated in API responses
- **Configurable similarity** — strategy pattern (`cosine`, `euclidean`, `dotProduct`) across all similarity-dependent modules
- **Config validation at load time** — Zod schema validation during `initialize()` catches errors before execution
- **Proper error boundaries** — bare `catch {}` blocks replaced with structured logging across 15+ modules

## Prerequisites

**Bun** (recommended, primary runtime):
```bash
curl -fsSL https://bun.sh/install | bash
```

**Node.js** (fallback, ≥20.0.0) — see `npm run start:node` below.

## Quick Start

```bash
# Install dependencies (Bun — 20x faster than npm)
bun install

# Start the HTTP server (requires Memgraph on bolt://localhost:7687)
bun run start

# Development mode with hot-reload
bun run dev

# Type-check (no emit)
bun run typecheck

# Or run a workflow directly from CLI
bun src/index.ts run src/workflows/examples/rag-memory-pipeline.json --input='{"query": "What is S2 chunking?"}'
```

> **Node.js fallback**: `npm install && npm run start:node` — uses `@hono/node-server` (installed as optional dependency).
>
> **Bun auto-loads `.env`**: No `dotenv` package needed. Copy `.env.example` to `.env` and Bun picks it up automatically.

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
> **Improvement roadmap**: **[docs/IMPROVE.md](docs/IMPROVE.md)**
>
> **Research papers** with archived PDFs: **[docs/PAPERS.md](docs/PAPERS.md)**

## API

```bash
# Health check
curl http://localhost:3000/health

# List modules
curl http://localhost:3000/modules

# Validate TOML prompts (Improvement #8)
curl http://localhost:3000/prompts/validate

# Reload TOML prompt cache (Improvement #15)
curl -X POST http://localhost:3000/prompts/reload

# Run a workflow (streaming via SSE)
curl -N -X POST http://localhost:3000/workflow/run/stream \
  -H "Content-Type: application/json" \
  -d '{"workflow": {...}, "input": {...}}'

# Run a workflow (non-streaming)
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

The Dockerfile uses a **multi-stage build** with `oven/bun:1` for fast dependency installation:

```bash
# Build and run (includes Memgraph + Bun runtime)
docker compose -f docker/docker-compose.yml up -d
```

Bun runs `.ts` directly — no `tsc` build step is needed in the container.

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