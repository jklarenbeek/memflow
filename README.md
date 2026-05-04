# MemFlow

**Self-Improving RAG & Lifelong Memory Workflow Engine**

MemFlow synthesizes 10+ cutting-edge research papers (2024–2026) into a composable, JSON-driven workflow engine with built-in learning loops and sub-workflow nesting. It registers **80 modules** — 42 atomic pipeline modules, 7 composite wrappers, 8 GMPL pattern modules, 9 evolution modules, and 14 standalone/infrastructure modules — backed by a Memgraph-persistent state store for crash recovery and long-running job resilience. The engine exposes MCP, ACP, and REST interfaces for integration with LLM-powered tools and agents.

The **Generic Multi-Agent Pattern Library (GMPL)** extends the core engine with 6 composable workflow patterns (Structured Debate, Clarification Pipeline, Parallel Analysis, Peer Review, Red Team, Delphi Expert Panel) that can be orchestrated, composed via the `PatternComposer` API, and specialized per domain. A reference **Trading Domain Adapter** (based on TradingAgents, arXiv:2412.20138v7) demonstrates the full plugin contract with 4 data providers, 7 entity schemas, an outcome evaluator, Sharpe/drawdown/win-rate metrics, and 5 domain-specific prompt packs.

The **Self-Evolution Layer** enables autonomous skill distillation, SLM training dataset export, prediction harness versioning, and natural-language workflow compilation. Backed by Trace2Skill (arXiv:2603.25158), AutoSkill (arXiv:2604.17614), and Milkyway (arXiv:2604.15719) research.

**MemFlow Desktop** (Phase 1) provides a native Tauri 2 desktop shell with an embedded Bun sidecar, streaming chat with inline DAG auditing, and a React frontend for Solution management, Conversation persistence, and Workflow Library browsing. The project is structured as a Bun workspace monorepo (`packages/desktop-app/`, `packages/shared/`).

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
  ├── ModuleRegistry (80 modules: lazy-loaded, instance-cached)
  ├── StateStore (Memgraph-backed, crash-recoverable, in-memory LRU cache)
  ├── WorkflowEventEmitter (typed event system for streaming + metrics)
  ├── Config Validation (Zod schemas validated at initialize(), not mid-pipeline)
  ├── GMPL (PatternRegistry, RoleRegistry, DomainRegistry, ErrorTypes)
  └── Stages → Module.process() → shared WorkflowData bus (with telemetry counters)
        ├── SubWorkflow stages → nested WorkflowEngine (shared context)
        ├── _stageConfigs override mechanism for per-stage config tuning
        └── MemgraphClient.batchQuery() → UNWIND-based batch operations

packages/ (monorepo workspaces)
  ├── shared/           — @memflow/shared: Zod API schemas (Solution, Conversation, Workflow)
  └── desktop-app/      — Tauri 2 + React + Vite desktop application
        ├── src-tauri/   — Rust: sidecar manager, Tauri plugins, IPC commands
        └── src/         — React frontend (stores, hooks, components, CSS design system)
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Module Inventory

MemFlow registers **80 modules** across 12 categories:

| Category | Count | Key Modules |
|---|---|---|
| Core | 2 | `SubWorkflow`, `AutonomousLoop` |
| Chunking | 5 | `S2Chunker`, `MarkdownSpatialParser`, `PDFSpatialParser`, `DOCXSpatialParser`, `ParentChildChunker` |
| Memory | 19 | SimpleMem (6 atomic), LightMem (7 atomic incl. `AttentionScore`), StructMem (3 atomic), + 3 composite wrappers |
| Retrieval | 9 | `IntentClassifier`, `VectorSearch`, `GraphSearch`, `KeywordSearch`, `ResultRanker`, `SymbolicSearch`, `SetUnionMerger`, `DualLevelRouter` + wrapper |
| Agents | 8 | `PlanGenerator`, `TrajectoryExecutor`, `RewardComputer`, `ExperienceReflector`, `RoPEEvolver`, `TopologyMutator`, `FinalSynthesizer` + wrapper |
| Graph | 6 | `ChunkIngestor`, `EntityExtractor`, `EntityDeduplicator`, `EntityProfiler`, `CommunityDetector` + wrapper |
| Generation | 7 | `QueryClarifier`, `AnswerGenerator`, `HallucinationValidator`, `CitationInjector`, `WebSearchAgent`, `DualSourceFusion` + wrapper |
| GMPL Patterns | 8 | `DebateModule`, `ConsensusJudge`, `MultiTurnClarifier`, `ParallelDispatcher`, `OutcomeMemory`, `PeerReviewModule`, `RedTeamModule`, `DelphiPanelModule` |
| Evolution | 9 | `SLMDatasetExporter`, `TraceCluster`, `SkillMerge`, `SkillInjector`, `Trace2Skill`, `HarnessEvolver`, `IntentCompiler`, `SkillBasisExtractor`, `SkillGapAnalyzer` |
| Trading Domain | — | `tradingAdapter`, `registerTradingRoles()`, 7 entity schemas, 5 prompt packs, 4 extended roles |
| Query | 1 | `QueryTranslator` |
| Providers | 2 | `Embedder`, `LLMProvider` |
| Advanced | 4 | `AgentContext`, `OutcomeLearner`, `Crystallizer`, `Contradiction` |

> **Full module reference** with input/output fingerprints, config schemas, and paper traceability: **[docs/MODULES.md](docs/MODULES.md)**
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

Seven tools exposed at `POST /mcp` for LLM agent integration:

| Tool | Description |
|---|---|
| `memflow_write` | Ingest content into the knowledge graph |
| `memflow_recall` | Hybrid search + LLM answer generation |
| `memflow_search` | Raw hybrid search (vector + graph + keyword) |
| `memflow_manage` | CRUD operations on existing memories |
| `memflow_entity_get` | Knowledge graph entity lookup |
| `gmpl_run_pattern` | Execute a GMPL pattern (debate, analysis, peer review, etc.) on-demand |
| `gmpl_resolve_outcome` | Resolve a pending decision with real-world outcome data |

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
| `/api/v1/datasets/export` | POST | Export SLM training dataset (SFT/DPO) |
| `/api/v1/skills` | GET | List distilled skills from Memgraph |
| `/api/v1/skills/gaps` | GET | Get skill gap analysis results |
| `/api/v1/skills/distill` | POST | Trigger Trace2Skill distillation pipeline |
| `/api/v1/harness/evolve` | POST | Evolve a prediction harness for a topic |
| `/api/v1/workflows/compile` | POST | Compile natural language → workflow JSON |
| `/api/v1/solutions` | POST/GET | Create and list Solutions (workspaces) |
| `/api/v1/solutions/:id` | GET/PATCH/DELETE | Get, update, or soft-delete a Solution |
| `/api/v1/conversations` | POST/GET | Create and list Conversations per Solution |
| `/api/v1/conversations/:id` | GET | Get conversation with full message history |
| `/api/v1/conversations/:id/messages` | POST | Add a message to a conversation |
| `/api/v1/conversations/:id/messages/:mid` | PATCH | Update message with audit trail |
| `/api/v1/conversations/:id/fork` | POST | Fork a conversation from a checkpoint |
| `/api/v1/workflows/catalog` | GET | List all available workflow JSONs |
| `/api/v1/workflows/catalog/:name` | GET | Get a workflow JSON by name |
| `/api/v1/migrate` | POST | Run solutionId state migration |
| `/api/v1/migrate/status` | GET | Check migration status |

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

Exposed metrics: `stage_duration_seconds` (histogram), `stage_errors_total` (counter), `workflow_runs_total` (counter), `workflow_duration_seconds` (histogram), `active_workflows` (gauge), `gmpl_pattern_rounds_total` (counter), `gmpl_pattern_duration_seconds` (histogram), `gmpl_errors_total` (counter), `gmpl_clarification_turns_total` (counter), `gmpl_consensus_quality_score` (gauge), `gmpl_pending_resolution_latency` (histogram), `memflow_dataset_exports_total` (counter), `memflow_dataset_samples_total` (counter), `memflow_skills_distilled_total` (counter), `memflow_skill_injections_total` (counter), `memflow_harness_versions_total` (counter), `memflow_harness_retrospective_results` (counter), `memflow_intent_compilations_total` (counter). Metrics collection is enabled by default and can be disabled via `enableMetrics: false` in `GlobalConfig`.

## Observability Stack

A pre-configured Prometheus + Grafana stack is included in `docker-compose.yml` under the `observe` profile:

```bash
# Add --profile observe to any existing command
docker compose -f docker/docker-compose.yml --profile cpu --profile observe up -d

# Or with deploy mode
docker compose -f docker/docker-compose.yml --profile deploy --profile cpu --profile observe up -d
```

- **Prometheus**: http://localhost:9090 — scrapes `/metrics` every 5s
- **Grafana**: http://localhost:3001 (login: `admin` / `admin`) — pre-provisioned dashboard with 12 panels: Stage Latency (p99), Stage Error Rate, Workflow Throughput, Active Workflows, Workflow Duration (p99), GMPL Pattern Duration (p99), GMPL Pattern Rounds, GMPL Error Rate by Code, Pattern Usage Distribution, Clarification Turns/min, and Pending Resolution Latency (p50/p99)

## Docker

The Dockerfile uses a **multi-stage build**: `oven/bun:1` for dependency installation, `memgraph/memgraph-mage` for the runtime layer. Bun runs `.ts` directly — no `tsc` build step is needed in the container.

All services are managed through **profiles** in a single `docker/docker-compose.yml`:

```bash
# ---------------------------------------------------------------------------
# Dev mode — infrastructure only (Memgraph + Ollama), run Bun locally
# ---------------------------------------------------------------------------
docker compose -f docker/docker-compose.yml --profile cpu up -d
bun run dev   # connects to localhost:7687 (Memgraph) + localhost:11434 (Ollama)

# ---------------------------------------------------------------------------
# Deploy mode — full containerised stack (MemFlow + Memgraph + Ollama)
# ---------------------------------------------------------------------------
docker compose -f docker/docker-compose.yml --profile deploy --profile cpu up -d

# GPU variants: replace --profile cpu with --profile amd-rocm or --profile amd-vulkan
```

> **Note:** Running without any `--profile` flag only starts Memgraph (the sole profile-less service). You must specify at least one GPU/CPU profile to start Ollama.

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` / `openrouter` / `openai` |
| `LLM_MODEL` | `qwen3.5:9b` | Model name |
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
3. `bun test` (default test suite — mocks only, no external services)
4. `docker build` (container image validation)

Optional: `bun test src/tests/integration/real-services/` runs against live Memgraph + Ollama when services are available (e.g., GPU runners).

## Testing

### Default Suite (fast, no external services)
```bash
bun test
```

Tests use a shared mock factory (`src/tests/helpers/mocks.ts`) that provides configurable mocks for WorkflowContext, LLM, Embeddings, and MemgraphClient — no external services required. The default suite covers 484 tests across 61 files: 47 unit test files (19 GMPL pattern/adapter/error, 12 evolution module, 16 core/memory/retrieval/chunking), 14 integration test files (6 mock E2E + 8 real-services), and workflow JSON structural validation.

### Real-Services Integration Suite (requires Memgraph + Ollama)

A 7-layer integration test suite validates the full stack against live Memgraph MAGE and Ollama services:

| Layer | File | Focus | Tests |
|---|---|---|---|
| 1 | `infra-health.test.ts` | Memgraph bolt, MAGE procedures, Ollama reachability, LLM/embedding smoke | 9 pass |
| 2 | `memgraph-schema.test.ts` | 17 node labels, 8 edge types, vector/scalar indexes, batch UNWIND | 32 pass |
| 3 | `providers-real.test.ts` | `MemgraphClient`, `LLMProvider`, `EmbeddingProvider`, `WorkflowContext` | 10 pass |
| 4 | `modules-real.test.ts` | Atomic modules: ChunkIngestor, VectorSearch, GraphSearch, dedup, ranking, etc. | 9 pass, 5 todo |
| 5 | `pipelines-real.test.ts` | Custom ingest→search→rank, parallel branches, SubWorkflow nesting | 3 pass, 5 todo |
| 6 | `e2e-api-real.test.ts` | `/health`, `/modules`, `/metrics`, MCP init/tools-list | 5 pass, 6 todo |
| 7 | `stability-real.test.ts` | MERGE idempotency, concurrent writes, 200-chunk batch, reconnection | 4 pass, 3 todo |

**Run the real-services suite:**
```bash
# Requires Memgraph MAGE on bolt://localhost:7687 and Ollama on http://localhost:11434
bun test src/tests/integration/real-services/ --timeout 120000
```

**CPU vs GPU execution:** On CPU, `qwen3.5:4b` takes 30–60s per LLM call. Tests marked `test.todo` (18 total) invoke LLM-dependent modules and JSON pipeline definitions. These can be run individually with `--timeout 600000` on GPU hardware (e.g., `bun test src/tests/integration/real-services/ --timeout 600000` runs all 484 tests including LLM workflows).

**Test isolation:** All tests use `__test__`-prefixed node IDs and `cleanupTestData()` in `afterEach` — no test data leaks between runs.


## License

MIT