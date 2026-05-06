# MemFlow Desktop — Follow-Up Roadmap

> Full code sweep completed 2026-05-05. This document catalogues every
> caveat, pain point, and optimisation opportunity discovered across the
> backend, desktop frontend, Tauri shell, module system, shared package,
> test suite, and build infrastructure. Items are grouped by priority tier
> and cross-referenced with concrete file paths.

---

## Priority 1 — Critical (Stability / Data Loss Risk)

### 1.1 Memgraph Connection Pool — `withMemgraph` creates a new connection per request

**Where**: `src/mcp/tools/_helpers.ts:37-62`
**Used by**: Every route file — 26 call sites across `solutions.ts`, `conversations.ts`, `executions.ts`, `graphExplorer.ts`, `migration.ts`

**Problem**: Each API request creates a new `MemgraphClient`, runs a query, then calls `client.close()`. Under concurrent load, this will exhaust Memgraph's connection limit and leak file descriptors. This is the single biggest performance/stability issue in the project.

**Fix**: Replace the per-request pattern with a **singleton connection pool**:

```ts
// src/server/db.ts (NEW)
let _pool: MemgraphClient | null = null;

export function getMemgraphPool(config: GlobalConfig): MemgraphClient {
  if (!_pool) {
    _pool = new MemgraphClient({ uri, user, password }, logger);
  }
  return _pool;
}

export async function shutdownPool() {
  if (_pool) { await _pool.close(); _pool = null; }
}
```

Then update `withMemgraph` to borrow from the pool instead of creating/destroying. All 26 call sites become zero-allocation.

**Risk if deferred**: Under 5+ concurrent requests, Memgraph will reject connections, causing 500 errors across all graph/solution/conversation endpoints.

---

### 1.2 Ingestion temp files are never cleaned up

**Where**: `src/server/routes/ingestion.ts:89-92`

**Problem**: When a file is uploaded via multipart:
```ts
const tmpDir = process.cwd();
filePath = `${tmpDir}/ingestion_${uuidv4()}_${filename}`;
await Bun.write(filePath, new Uint8Array(bytes));
```
These temp files are written to the project root (`process.cwd()`) and **never deleted**. Over time, this will fill the disk with stale uploaded documents.

**Fix**:
1. Use `os.tmpdir()` or a dedicated `data/ingestion-tmp/` directory
2. Delete the file in a `finally` block or a background cleanup timer
3. Consider streaming the file content directly to the parser instead of writing to disk

---

### 1.3 No authentication / authorisation on any endpoint

**Where**: `src/server/index.ts` — no middleware chain, all routes are public

**Problem**: Every endpoint (including `DELETE /solutions/:id`, `POST /migrate`, `POST /workflow/run`) is callable by anyone on the network. The `/health` endpoint exposes internal service versions and module lists.

**Fix**: For desktop single-user mode, bind exclusively to `127.0.0.1` (already done in sidecar) and add a shared-secret header (`X-MemFlow-Token`) validated by Hono middleware. This prevents any other local process from calling the API.

---

## Priority 2 — Performance & Architecture

### 2.1 Frontend API client uses `Record<string, unknown>` everywhere

**Where**: `packages/desktop-app/src/lib/api.ts` — 21 occurrences of `Record<string, unknown>`

**Problem**: The API client returns `Record<string, unknown>` for solutions, conversations, messages, workflows, and executions. This forces `as` casts throughout every component and store, defeating TypeScript's safety. When the backend schema changes, the frontend won't catch type mismatches at compile time.

**Fix**: Export response interfaces from `@memflow/shared` and use them in the API client:
```ts
// @memflow/shared
export interface Solution { id: string; name: string; domain: string; ... }
export interface Conversation { id: string; title: string; solutionId: string; ... }
export interface Message { id: string; role: 'user'|'assistant'; content: string; ... }
```

The `api.ts` client should return `Promise<{ success: boolean; solution: Solution }>` instead of `Promise<{ success: boolean; solution: Record<string, unknown> }>`.

**Impact**: Eliminates ~40+ `as Record<string, unknown>` casts across stores and components.

---

### 2.2 Monolithic CSS — `App.css` is 65KB / 2330 lines

**Where**: `packages/desktop-app/src/App.css` — single file, all styles

**Problem**: All styling for 31 components lives in one file. No CSS modules, no scoping. Class name collisions are prevented only by naming convention. IDE search/autocomplete is hampered. Contributors can't reason about which styles belong to which component.

**Fix**: Split into CSS modules co-located with components:
```
components/chat/ChatPane.module.css
components/dag/WorkflowDAG.module.css
components/graph/GraphExplorer.module.css
```
Keep `App.css` for global reset, CSS variables, and theme tokens only (~200 lines). Import the `.module.css` files in each component for scoped class names.

---

### 2.3 `useWorkflowStream` mixes concerns — SSE parsing + chat persistence + store mutations

**Where**: `packages/desktop-app/src/hooks/useWorkflowStream.ts`

**Problem**: This 155-line hook does five things at once:
1. Persists user/assistant messages to the backend
2. Opens and reads a streaming fetch response
3. Parses SSE events
4. Updates chat store state
5. Handles errors and cancellation

This makes it impossible to reuse SSE streaming outside the chat context (e.g., for ingestion progress tracking, or future execution replay).

**Fix**: Split into three layers:
- `useSSEStream(url, body)` — generic ReadableStream SSE reader with abort support (pure event emitter)
- `useWorkflowEvents(events)` — maps workflow events to DAG + stage store mutations
- `useWorkflowChat(options)` — orchestrates persistence + streaming + chat store updates

---

### 2.4 Graph store does parallel API calls without batching or cancellation

**Where**: `packages/desktop-app/src/stores/graphStore.ts:103-164`

**Problem**: `loadInitialGraph` fires 3 sequential API calls (stats → communities → subgraph). If the user switches solutions quickly, stale responses overwrite fresh data. There's no AbortController, no request deduplication, and no loading skeleton per-section.

**Fix**:
1. Add an AbortController per load cycle — cancel stale requests when a new load starts
2. Consider `Promise.all` for stats + communities (they're independent)
3. Add per-section loading states instead of a single `loading` boolean
4. Add a request ID / generation counter to discard stale responses

---

### 2.5 `normalizeNode` / `normalizeValue` — recursive, untyped, applied on every response

**Where**: `src/server/routes/_helpers.ts:12-58`

**Problem**: Every Memgraph response is recursively normalized to unwrap Neo4j Integer and Node objects. This is O(n) per response but also **completely untyped** — it returns `Record<string, unknown>`, stripping all type information. The Neo4j Integer check (`"low" in val && "high" in val`) is fragile — any object with `low` and `high` properties will be misinterpreted.

**Fix**:
1. Use the `neo4j-driver`'s built-in `Integer.toNumber()` at the `MemgraphClient` layer so routes never see raw driver types
2. Alternatively, configure `MemgraphClient` to use `{ disableLosslessIntegers: true }` in the driver options — this makes the driver return native JS numbers instead of `Integer` wrappers
3. Remove the recursive normaliser entirely

---

## Priority 3 — Developer Experience & Code Quality

### 3.1 `@memflow/shared` is too thin — only schemas, no response types

**Where**: `packages/shared/src/` — 3 schema files, ~4KB total

**Problem**: The shared package exports Zod schemas for validation but doesn't export TypeScript interfaces for API responses. The backend routes define response shapes inline, and the frontend `api.ts` duplicates them with `Record<string, unknown>`. There's no single source of truth for the API contract.

**Fix**: Extend `@memflow/shared` to export:
- `Solution`, `Conversation`, `Message` interfaces (derived from Zod schemas via `z.infer<>`)
- API response wrapper types: `ApiResponse<T>`, `PaginatedResponse<T>`
- Execution, workflow, and graph-related types
- `@memflow/shared` should also export route path constants to avoid string duplication

---

### 3.2 Silent `catch {}` blocks across 17 locations in the module system

**Where**: Various modules — see list below

| File | Line | Context |
|---|---|---|
| `executions.ts` | 157, 191, 195 | JSON parse failures silently ignored |
| `SymbolicSearchModule.ts` | 71 | Filter parse failure |
| `ResultRankerModule.ts` | 73 | Memory search failure |
| `SensoryBufferModule.ts` | 111, 135 | Persistence + retrieval failures |
| `SleepConsolidationModule.ts` | 90 | Embedding failure |
| `STMBufferModule.ts` | 106, 152, 205 | Persistence, embedding, retrieval |
| `EntityProfilerModule.ts` | 48 | Profiling failure |
| `TraceClusterModule.ts` | 75 | Parse failure |
| `SkillGapAnalyzerModule.ts` | 80 | Parse failure |
| `SkillBasisExtractorModule.ts` | 75 | Parse failure |
| `ACPSession.ts` | 56 | Subscriber error |

**Problem**: When these operations fail, there's no telemetry, no log line, and no way to debug in production. Memory persistence failures are particularly dangerous — the system silently drops memories without any indication.

**Fix**: Add a lightweight `log.warn()` or emit a `module:warning` event in each catch block. For persistence failures (STMBuffer, SensoryBuffer), consider a retry mechanism or at minimum a counter metric.

---

### 3.3 Health poller runs on a fixed 5s interval regardless of app state

**Where**: `packages/desktop-app/src/hooks/useMemFlowAPI.ts:21-53`

**Problem**: The health poller fires every 5 seconds even when the app is in the background, the tab is hidden, or the user is actively typing. This generates unnecessary network traffic and Memgraph connection churn (due to the pool issue in 1.1).

**Fix**:
1. Use `document.visibilityState` to pause polling when the app is hidden
2. Increase the interval to 15-30s when healthy; decrease to 3s when degraded
3. After implementing the connection pool (1.1), a health check is just a `SELECT 1` — but still wasteful when the app is backgrounded

---

### 3.4 Duplicated `StageStatus` type between stores

**Where**:
- `packages/desktop-app/src/stores/chatStore.ts:6-12` — `StageStatus`
- `packages/desktop-app/src/stores/dagStore.ts:9-19` — `DAGStageStatus`

**Problem**: Two nearly identical interfaces exist for workflow stage status. `DAGStageStatus` is a superset of `StageStatus` with extra fields (`preview`, `metrics`, `attempt`, `progress`). Components importing from the wrong store will have type mismatches.

**Fix**: Define a single `StageStatus` type (either in a shared `types.ts` or import from `@memflow/shared`) and use it in both stores.

---

### 3.5 Three `as any` casts in server code

**Where**:
- `src/server/index.ts:43` — MemgraphClient logger
- `src/server/index.ts:177` — error code access
- `src/server/acp.ts:11` — ACP workflow config

**Fix**: Define proper interfaces for the logger and error types. The ACP workflow should use the `WorkflowConfig` type from core.

---

## Priority 4 — Security & Robustness

### 4.1 File ingestion path traversal vulnerability

**Where**: `src/server/routes/ingestion.ts:96-113` — path mode

**Problem**: The path-mode ingestion accepts `filePath` directly from the request body and reads it via `Bun.file(filePath)`. There's no path sanitization, no allowlist, and no check that the path is within an expected directory. An attacker on the local network could read any file on the system:
```json
{ "filePath": "/etc/passwd", "solutionId": "..." }
```

**Fix**:
1. Validate that `filePath` resolves to within a configured ingestion directory
2. Use `path.resolve()` and check it starts with the allowed prefix
3. Reject absolute paths or paths containing `..`

---

### 4.2 `process.cwd()` used for workflow file resolution

**Where**: `src/server/routes/workflowCatalog.ts:41, 59, 77`

**Problem**: Workflow catalog paths are resolved relative to `process.cwd()`. When running as a Tauri sidecar, `cwd` may not be the repo root (depends on how the child process is spawned). This can cause workflow discovery to fail silently.

**Fix**: Use `import.meta.dir` (Bun-specific) or derive the project root from `import.meta.url` to ensure paths are always relative to the source tree, not the working directory.

---

### 4.3 Sidecar uses `Mutex<T>` with `.unwrap()` — potential panics

**Where**: `packages/desktop-app/src-tauri/src/sidecar.rs` — 30+ `.lock().unwrap()` calls

**Problem**: If any Mutex is poisoned (e.g., a thread panics while holding a lock), every subsequent `.unwrap()` will panic, crashing the entire desktop app.

**Fix**: Replace `.unwrap()` with `.lock().unwrap_or_else(|e| e.into_inner())` to recover from poisoned mutexes, or use `parking_lot::Mutex` which never poisons.

---

## Priority 5 — Frontend Polish & UX

### 5.1 Lazy-loaded tabs flash on first visit

**Where**: `packages/desktop-app/src/App.tsx:24-32`

**Problem**: Graph, DAG, and Ingestion tabs use `React.lazy()` with a minimal spinner fallback. On first visit, there's a visible flash of the loading spinner before the component renders. The chunks are small (each tab < 15KB) but the perceived delay is jarring.

**Fix**:
1. Preload the chunks on idle: `requestIdleCallback(() => import('./components/graph/GraphExplorer'))`
2. Or remove lazy loading entirely — the total component bundle is ~124KB, which is well within acceptable limits for a desktop app
3. Add a skeleton fallback that matches the tab's layout instead of a generic spinner

---

### 5.2 `WorkflowDAG.tsx` is 15KB — the largest component

**Where**: `packages/desktop-app/src/components/dag/WorkflowDAG.tsx` — 15,844 bytes

**Problem**: This single component handles React Flow node/edge layout, stage status rendering, toolbar actions (load/run/reset), DAG layout algorithm, and inspector panel toggling. It's difficult to test or modify in isolation.

**Fix**: Extract into sub-components:
- `DAGToolbar.tsx` — load/run/reset buttons
- `DAGCanvas.tsx` — React Flow canvas with nodes/edges
- `DAGNodeRenderer.tsx` — custom node rendering per stage status
- Keep `WorkflowDAG.tsx` as a thin orchestrator

---

### 5.3 No error boundaries anywhere in the component tree

**Where**: `packages/desktop-app/src/App.tsx` — no `<ErrorBoundary>`

**Problem**: If any component throws during render (e.g., the graph canvas receives malformed data), the entire app crashes with a white screen. React error boundaries are the standard solution but none are implemented.

**Fix**: Wrap each tab in an `<ErrorBoundary>` that shows an inline error message with a "Retry" button. Add a top-level boundary around `<App>` as a last resort.

---

### 5.4 No loading/empty states for sidebar sections

**Where**: `packages/desktop-app/src/components/sidebar/SolutionList.tsx`, `ConversationTree.tsx`, `WorkflowLibrary.tsx`

**Problem**: When these components are loading data or the result set is empty, there's no visual feedback — just a blank panel. The user doesn't know if data is loading or genuinely absent.

**Fix**: Add skeleton loaders during fetches and descriptive empty states ("No solutions yet — create one to get started").

---

## Priority 6 — Testing & CI

### 6.1 No unit tests for frontend components or stores

**Where**: `packages/desktop-app/` — 0 test files

**Problem**: The entire frontend (31 components, 6 stores, 3 hooks) has zero test coverage. Store logic (graphStore, dagStore, chatStore) is complex enough to warrant unit tests, especially the deduplication logic and state transitions.

**Fix**:
1. Add Vitest to the desktop-app package
2. Write store unit tests for graphStore (deduplication, expansion, filter state)
3. Write hook tests for useWorkflowStream (mock SSE events, verify store mutations)
4. Component tests can be deferred — stores and hooks are the highest-value targets

---

### 6.2 E2E tests require a running server — no mock mode

**Where**: `src/tests/integration/real-services/` — all tests need live Memgraph + server

**Problem**: The E2E test suite can only run against live infrastructure. There's no mock/stub mode for CI environments without Memgraph or Ollama. This prevents running tests in GitHub Actions without a Docker-in-Docker setup.

**Fix**:
1. Add a `msw` (Mock Service Worker) layer for frontend API testing without a backend
2. For backend integration tests, use `testcontainers-node` to spin up a disposable Memgraph container
3. Keep the live-service tests as a separate `bun test --filter real-services` suite

---

### 6.3 No performance regression detection

**Where**: `src/tests/integration/real-services/perf-benchmarks.test.ts`

**Problem**: The benchmark suite runs and prints results, but there's no baseline comparison. Performance regressions can only be caught by a human reading the output. The results aren't persisted anywhere.

**Fix**:
1. Write benchmark results to `benchmarks/results.json` after each run
2. Compare against the previous baseline on subsequent runs
3. Fail the test if any endpoint regresses by >50% from its baseline
4. Add a `bun run bench` script that runs the benchmark suite and updates the baseline

---

## Priority 7 — Build & Infrastructure

### 7.1 Tauri build requires Rust toolchain — adds 2GB+ download for first-time contributors

**Where**: `packages/desktop-app/src-tauri/` — Rust project

**Problem**: Building the desktop app requires the Rust toolchain (~2GB), Tauri CLI, and Windows SDK. This is a significant barrier for frontend-only contributors.

**Fix**:
1. Pre-build Tauri releases via CI and publish them as GitHub Releases
2. Document a "frontend-only" development path using `bun run dev` (Vite-only mode) that works without Rust
3. Consider using `@nicegui/native` or `electron` as a lighter-weight alternative for contributors who don't need the Rust sidecar features

---

### 7.2 No `.env.example` or secrets documentation

**Where**: Root `.env` — contains live API keys

**Problem**: The `.env` file contains actual keys (Tavily, Ollama config). There's no `.env.example` template for new contributors, and no documentation about which env vars are required vs optional.

**Fix**: Create `.env.example` with all variables, their descriptions, and placeholder values. Ensure `.env` is in `.gitignore` (verify it isn't committed).

---

## Priority 8 — Module System Enhancements

### 8.1 Module error isolation — one failing module kills the workflow

**Where**: `src/core/WorkflowEngine.ts`

**Problem**: If a module throws an unhandled error, the entire workflow execution fails. There's no per-stage error isolation, no automatic retry for transient failures (e.g., Ollama timeout), and no circuit breaker for consistently failing modules.

**Fix**:
1. Wrap each `module.execute()` in a try/catch with configurable retry policy (per-stage `retries` field in workflow JSON)
2. Add a `continueOnError` stage option that marks the stage as failed but continues the pipeline
3. Emit `stage:retry` SSE events so the frontend can visualise retry attempts

---

### 8.2 Module registry has no lifecycle hooks

**Where**: `src/core/ModuleRegistry.ts`

**Problem**: Modules are instantiated eagerly at startup. There's no `onStartup()` / `onShutdown()` lifecycle hook for modules that need to initialize expensive resources (e.g., embedding model warm-up, Memgraph index creation).

**Fix**: Add optional `initialize(config)` and `shutdown()` methods to the `Module` interface, called during server startup/shutdown respectively.

---

## Priority 9 — Future Architecture

### 9.1 No offline/local-first capability

**Problem**: The desktop app is fully dependent on the backend server being running and healthy. If Memgraph goes down, the entire UI is unusable — even reading cached data is impossible.

**Fix** (long-term):
1. Cache the last-known solution list, conversations, and graph stats in the Zustand persist layer
2. Show cached data with a "stale" indicator when the backend is unreachable
3. Queue user actions (create solution, send message) and replay when connectivity is restored

---

### 9.2 No plugin/extension system for community modules

**Problem**: Adding new modules requires modifying the core codebase. There's no way for third-party developers to create and distribute custom workflow modules (e.g., a Notion ingester, a Slack connector).

**Fix** (long-term):
1. Define a `MemFlowPlugin` interface with `register(registry: ModuleRegistry)` entry point
2. Load plugins from a `~/.memflow/plugins/` directory at startup
3. Publish an `@memflow/sdk` package with the Module base class and type definitions

---

## Summary

| Priority | Items | Effort Estimate |
|---|---|---|
| **P1 — Critical** | Connection pool, temp cleanup, auth | 2-3 days |
| **P2 — Performance** | Typed API, CSS split, SSE refactor, graph abort, normaliser | 3-5 days |
| **P3 — DX** | Shared types, silent catches, poller, dedup types, any casts | 2-3 days |
| **P4 — Security** | Path traversal, cwd resolution, mutex safety | 1-2 days |
| **P5 — UX** | Lazy preload, DAG split, error boundaries, empty states | 2-3 days |
| **P6 — Testing** | Frontend tests, mock mode, perf regression | 3-5 days |
| **P7 — Build** | CI releases, env docs | 1-2 days |
| **P8 — Modules** | Error isolation, lifecycle hooks | 2-3 days |
| **P9 — Future** | Offline mode, plugin system | 5-10 days |

**Total estimated effort**: 21-36 days (single developer, full-time)

**Recommended execution order**: P1 → P4 → P2.1 → P2.5 → P3.1 → P5.3 → P2.2 → P6.1 → rest
