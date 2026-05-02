# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It decomposes complex RAG capabilities into **39 atomic modules** — each independently consumable — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience. The engine exposes MCP, ACP, and REST interfaces for integration with LLM-powered tools and agents.

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

# Run test suite
bun test

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
  ├── ModuleRegistry (59 modules: lazy-loaded, instance-cached)
  ├── StateStore (Memgraph-backed, crash-recoverable, in-memory LRU cache)
  ├── WorkflowEventEmitter (typed event system for streaming + metrics)
  ├── Config Validation (Zod schemas validated at initialize(), not mid-pipeline)
  └── Stages → Module.process() → shared WorkflowData bus (with telemetry counters)
        ├── SubWorkflow stages → nested WorkflowEngine (shared context)
        ├── _stageConfigs override mechanism for per-stage config tuning
        └── MemgraphClient.batchQuery() → UNWIND-based batch operations
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Module Inventory

MemFlow registers **59 modules** across 10 categories:

| Category | Count | Key Modules |
|---|---|---|
| Core | 2 | `SubWorkflow`, `AutonomousLoop` |
| Chunking | 3 | `S2Chunker`, `MarkdownSpatialParser`, `ParentChildChunker` |
| Memory | 19 | SimpleMem (6 atomic), LightMem (7 atomic incl. `AttentionScore`), StructMem (3 atomic), + 3 composite wrappers |
| Retrieval | 9 | `IntentClassifier`, `VectorSearch`, `GraphSearch`, `KeywordSearch`, `ResultRanker`, `SymbolicSearch`, `SetUnionMerger`, `DualLevelRouter` + wrapper |
| Agents | 8 | `PlanGenerator`, `TrajectoryExecutor`, `RewardComputer`, `ExperienceReflector`, `RoPEEvolver`, `TopologyMutator`, `FinalSynthesizer` + wrapper |
| Graph | 6 | `ChunkIngestor`, `EntityExtractor`, `EntityDeduplicator`, `EntityProfiler`, `CommunityDetector` + wrapper |
| Generation | 7 | `QueryClarifier`, `AnswerGenerator`, `HallucinationValidator`, `CitationInjector`, `WebSearchAgent`, `PriHAReconciler` + wrapper |
| Query | 1 | `QueryTranslator` |
| Providers | 2 | `Embedder`, `LLMProvider` |
| Advanced | 2 | `AgentContext`, `OutcomeLearner`, `Crystallizer`, `Contradiction` |

> **Full module reference** with input/output fingerprints, config schemas, and paper traceability: **[docs/MODULES.md](docs/MODULES.md)**
>
> **Improvement roadmap**: **[docs/IMPROVE.md](docs/IMPROVE.md)**
>
> **Research papers** with archived PDFs: **[docs/PAPERS.md](docs/PAPERS.md)**

## API Endpoints

### Core Workflow

```bash
# Health check (includes Memgraph, Ollama, Tavily dependency checks)
curl http://localhost:3000/health

# List registered modules
curl http://localhost:3000/modules

# Run a workflow (non-streaming)
curl -X POST http://localhost:3000/workflow/run \
  -H "Content-Type: application/json" \
  -d '{"workflow": {...}, "input": {"query": "..."}}'

# Run a workflow (SSE streaming)
curl -N -X POST http://localhost:3000/workflow/run/stream \
  -H "Content-Type: application/json" \
  -d '{"workflow": {...}, "input": {...}}'
```

### MCP (Model Context Protocol)

Five tools exposed at `POST /mcp` for LLM agent integration:

| Tool | Description |
|---|---|
| `memflow_write` | Ingest content into the knowledge graph |
| `memflow_recall` | Hybrid search + LLM answer generation |
| `memflow_search` | Raw hybrid search (vector + graph + keyword) |
| `memflow_manage` | CRUD operations on existing memories |
| `memflow_entity_get` | Knowledge graph entity lookup |

### ACP (Agent Client Protocol)

Agent-to-agent messaging via `POST /acp` (request/response) and `GET /acp` (SSE streaming).

### REST API (`/api/v1`)

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/memories` | POST | Ingest memory content |
| `/api/v1/memories` | GET | List memories (paginated, searchable) |
| `/api/v1/memories/:id` | GET | Get memory by ID with relations |
| `/api/v1/memories/:id` | PATCH | Update memory content or metadata |
| `/api/v1/memories/:id` | DELETE | Soft-delete a memory |
| `/api/v1/search` | POST | Hybrid search without LLM generation |
| `/api/v1/recall` | POST | Search + LLM-generated answer |
| `/api/v1/entities` | GET | List graph entities (filterable) |
| `/api/v1/entities/:id` | GET | Get entity by ID with relations |
| `/api/v1/graph` | GET | Graph statistics (node/relation counts) |

### Prompt Management

```bash
# Validate TOML prompt references
curl http://localhost:3000/prompts/validate

# Reload TOML prompt cache (hot-reload)
curl -X POST http://localhost:3000/prompts/reload
```

### Prometheus Metrics

```bash
# Prometheus exposition format
curl http://localhost:3000/metrics
```

Exposed metrics: `stage_duration_seconds` (histogram), `stage_errors_total` (counter), `workflow_runs_total` (counter), `workflow_duration_seconds` (histogram), `active_workflows` (gauge). Metrics collection is enabled by default and can be disabled via `enableMetrics: false` in `GlobalConfig`.

## Observability Stack

A pre-configured Prometheus + Grafana stack is provided:

```bash
docker compose -f docker/docker-compose.observability.yml up -d
```

- **Prometheus**: http://localhost:9090 — scrapes `/metrics` every 5s
- **Grafana**: http://localhost:3001 (login: `admin` / `admin`) — pre-provisioned dashboard with 5 panels: Stage Latency (p99), Stage Error Rate, Workflow Throughput, Active Workflows, and Workflow Duration (p99)

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
| `TAVILY_API_KEY` | — | Required for web search |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORT` | `3000` | HTTP server port |

## CI/CD

GitHub Actions CI runs on every push and pull request:

1. `bun install --frozen-lockfile`
2. `bun run typecheck` (TypeScript compilation check)
3. `bun test` (full test suite)
4. `docker build` (container image validation)

## Testing

```bash
bun test
```

Tests use a shared mock factory (`src/tests/helpers/mocks.ts`) that provides configurable mocks for WorkflowContext, LLM, Embeddings, and MemgraphClient — no external services required. The test suite covers unit tests (14 files), integration tests (3 files), and workflow JSON validation.

## License

MIT