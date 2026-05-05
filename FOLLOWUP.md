# MemFlow Desktop — Development Follow-Up

> **Status**: Phase 2 Sprints 1–2 **complete**. Sprint 3 (Graph Explorer) **next**.
>
> **Date**: 2026-05-05

---

## Phase 1 — Foundation MVP ✅ COMPLETE

Phase 1 as defined by `docs/new/PROPOSAL.md` (and `PROPOSAL_01.md`) is now fully implemented.

### Server-Side API (4 route files, 24 tests, 90+ assertions)

| Route File | Endpoints | Tests |
|---|---|---|
| `src/server/routes/solutions.ts` | POST/GET/PATCH/DELETE `/api/v1/solutions` | 6 pass |
| `src/server/routes/conversations.ts` | POST/GET `/api/v1/conversations`, messages CRUD, fork | 6 pass |
| `src/server/routes/workflowCatalog.ts` | GET `/api/v1/workflows/catalog` | 3 pass |
| `src/server/routes/migration.ts` | POST/GET `/api/v1/migrate` | 3 pass |

**API Response Normalization**: All routes now use `normalizeNode()` from `src/server/routes/_helpers.ts` to return flat JSON instead of raw Memgraph Node objects. Tests no longer require `props()`/`num()` unwrapper helpers.

**New Memgraph Labels**: `:Solution`, `:Conversation`, `:Message`, `:MigrationLog`

**New Workflow**: `src/workflows/service/chat.json` — intent-aware chat workflow with conditional retrieval.

### Tauri 2 Desktop Shell

| Component | File | Status |
|---|---|---|
| Rust sidecar manager | `src-tauri/src/sidecar.rs` (406 lines) | ✅ Full process lifecycle |
| Tauri config | `src-tauri/tauri.conf.json` | ✅ Permissions, window size, plugins |
| Plugin registration | `src-tauri/src/lib.rs` (43 lines) | ✅ setup(), cleanup, IPC commands |

First launch verified: `bun run tauri dev` compiles (~1m42s first build, 450 crates), hot-reload after.

### React Frontend — Complete Component Tree

| Component | File | Status |
|---|---|---|
| **Stores** | `appStore.ts`, `chatStore.ts`, `sidecarStore.ts` | ✅ Zustand + localStorage persistence |
| **Hooks** | `useSSE.ts`, `useWorkflowStream.ts`, `useMemFlowAPI.ts` | ✅ Streaming + health polling |
| **API client** | `lib/api.ts` | ✅ Typed fetch wrapper, all endpoints |
| **SolutionList** | `components/sidebar/SolutionList.tsx` | ✅ CRUD + loading + error + domain icons |
| **ConversationTree** | `components/sidebar/ConversationTree.tsx` | ✅ List + create + relative timestamps |
| **WorkflowLibrary** | `components/sidebar/WorkflowLibrary.tsx` | ✅ Searchable catalog by category |
| **ChatPane** | `components/chat/ChatPane.tsx` | ✅ History loading, streaming, workflow fallback |
| **MessageBubble** | `components/chat/MessageBubble.tsx` | ✅ Markdown + syntax highlighting + copy + timestamps |
| **MessageDAGMini** | `components/chat/MessageDAGMini.tsx` | ✅ Stage flow, collapse/expand, clickable nodes |
| **StageInspector** | `components/chat/StageInspector.tsx` | ✅ Slide-out drawer for stage I/O |
| **SettingsDialog** | `components/settings/SettingsDialog.tsx` | ✅ Connection/Appearance/About tabs |
| **ConnectionStatus** | `components/settings/ConnectionStatus.tsx` | ✅ Health badges (compact + expanded) |
| **ConnectionWizard** | `components/onboarding/ConnectionWizard.tsx` | ✅ 4-step first-launch onboarding |
| **CommandPalette** | `components/palette/CommandPalette.tsx` | ✅ Cmd+K fuzzy search + theme toggle |
| **TopBar** | `components/layout/TopBar.tsx` | ✅ Health dots, settings gear, theme toggle |
| **StatusBar** | `components/layout/StatusBar.tsx` | ✅ Service health badges + version |
| **LoadingSkeleton** | `components/shared/LoadingSkeleton.tsx` | ✅ Shimmer skeleton (line/circle/card) |

**Design System**: `App.css` — 850+ lines with CSS variables, dark/light themes, Inter font, premium design, shimmer animations, slide-out transitions, markdown/code styling.

**Dependencies added**: `react-markdown@10.1.0`, `rehype-highlight@7.0.2`, `remark-gfm@4.0.1`

---

## Phase 2 — Core Features (IN PROGRESS)

As defined in `docs/new/PROPOSAL_02.md`, Phase 2 covers 6 sprints across 10–12 weeks.

### Sprint 1: Server APIs + Chat E2E Hardening ✅ COMPLETE

**Server Route Files Implemented**:

| Route File | Endpoints | Status |
|---|---|---|
| `src/server/routes/graphExplorer.ts` | GET neighbors, POST subgraph, GET communities, GET timeline, GET stats | ✅ Implemented |
| `src/server/routes/modules.ts` | GET `:name/schema` (Zod → JSON Schema), GET `:name/description` | ✅ Implemented |
| `src/server/routes/executions.ts` | POST create, GET list (paginated), GET `:id` detail | ✅ Implemented |
| `src/server/routes/ingestion.ts` | POST `/ingest` (dual-mode: Tauri IPC path + multipart/form-data) | ✅ Implemented |
| `src/server/routes/gmplPatterns.ts` | GET `/gmpl/patterns`, GET `/gmpl/roles` | ✅ Implemented |

**All 5 routers mounted in `api.ts`** under `/api/v1/graph/*`, `/api/v1/modules/*`, `/api/v1/executions`, `/api/v1/ingest`, `/api/v1/gmpl/*`.

**Service Workflow**: `src/workflows/service/ingest-file.json` — 6-stage file ingestion pipeline (MarkdownParser → S2Chunking → EmbeddingGenerator → GraphIndexer → FactExtractor → MemoryPersistence).

**Chat E2E Test Suite**: `src/tests/integration/real-services/chat-e2e.test.ts` — 12 pass, 3 todo. Validates SSE endpoint health, event structure, sequence integrity, and error recovery with graceful truncation handling for slow CPU-based LLM processing.

**New dependencies**: `zod-to-json-schema@3.25.2`

**New Memgraph Label**: `:WorkflowExecution` (id, solutionId, conversationId, workflowName, status, stageCount, durationMs, finalAnswer, stageTraceJson, stateJson, tokenUsage, error, createdAt)

**Commits**: `4b6771f` (server routes), `bd50e40` (E2E tests + ingest-file workflow)

### Sprint 2: Tab System + Visual DAG Runner ✅ COMPLETE

**Tab System**: Full tab-based navigation with 4 views (Chat, DAG Runner, Graph, Ingestion).

| Component | File | Status |
|---|---|---|
| **Tab State** | `appStore.ts` — `activeTab: AppTab` | ✅ Zustand persisted |
| **TabBar** | `components/layout/TabBar.tsx` | ✅ Animated indicator + badge |
| **App.tsx** | Tab-switched main area | ✅ Lazy loading + `Ctrl+1-4` shortcuts |

**DAG Visualizer**: Full-screen interactive workflow DAG viewer with live execution overlay.

| Component | File | Status |
|---|---|---|
| **DAG Store** | `stores/dagStore.ts` | ✅ Workflow, statuses, execution lifecycle, inspector |
| **WorkflowDAG** | `components/dag/WorkflowDAG.tsx` | ✅ React Flow canvas, topological layout, SSE streaming, catalog browser |
| **StageNode** | `components/dag/StageNode.tsx` | ✅ Custom node with status/duration/error |
| **DAGControls** | `components/dag/DAGControls.tsx` | ✅ Run/reset/load, layout toggle (TB/LR), fit view |
| **StageStatusBadge** | `components/dag/StageStatusBadge.tsx` | ✅ Reusable status indicator |

**API Client**: 15 new endpoint methods added to `lib/api.ts` — module introspection (2), execution history (3), graph explorer (5), GMPL patterns (2), plus existing workflow catalog (3).

**Design System**: `App.css` expanded to **1,310+ lines** — tab bar, DAG canvas, stage nodes, catalog overlay, inspector sidebar, placeholder states, loading spinners.

**Key design decisions**:
- **Built-in topological layout** using Kahn's algorithm — no external dagre/elkjs dependency needed
- **`@xyflow/react`** (already in package.json) provides React Flow canvas, controls, minimap, and background
- **Lazy loading** via `React.lazy()` + `Suspense` for the heavy React Flow import
- **SSE streaming execution** — DAG view reads `/workflow/run/stream` directly and updates stage nodes in real-time

**Commits**: `d575729`

### Sprint 3: Graph Explorer with Memgraph Orb (Current)

**Goal**: Browse and query the knowledge graph using Memgraph's native visualization library.

**Decision**: Using `@memgraph/orb@~0.4.3` instead of Cytoscape.js — native Memgraph integration, Canvas 2D with d3-force layout, TypeScript-native.

**Key components**:
- `GraphCanvas.tsx` — Orb container with `orb.data.setup()` / `orb.data.merge()` / `orb.events`
- `NodeDetails.tsx` — side panel for selected node properties
- `GraphFilters.tsx` — label, time range, community, solution filters
- `CommunityPanel.tsx` — community listing with top entities

**Dependencies to add**: `@memgraph/orb@~0.4.3`

### Sprint 4: File Ingestion UI (Pending)

**Goal**: Drag-and-drop file ingestion with dual-mode transport.

**Key components**:
- `DropZone.tsx` — Tauri IPC path (desktop) + multipart/form-data (external)
- `FileQueue.tsx` — per-file SSE progress tracking
- `IngestionResults.tsx` — summary with "View in Graph" navigation

### Sprint 5: Domain Solutions + GMPL Quick-Run (Pending)

**Goal**: Domain-scoped Solution wizard + one-click GMPL pattern execution.

**Key components**:
- `SolutionWizard.tsx` — 4-step domain creation wizard
- `PatternSelector.tsx` — grid of pattern cards from PatternRegistry
- `PatternConfigForm.tsx` — auto-generated config forms

### Sprint 6: Integration + Cross-Platform Polish (Pending)

- [ ] Integration test suite for all Phase 2 endpoints
- [ ] Cross-platform build verification
- [ ] Performance testing (graph < 2s load, < 200 nodes)
- [ ] Dark/light theme consistency across all new views

---

## Phase 3a — Studio (Future)

- [ ] Multi-Agent Studio (PatternComposer visual wiring)
- [ ] Cowork Scheduler + daemon mode
- [ ] Metrics Dashboard (Recharts)

## Phase 3b — Builder (Future)

- [ ] Visual Workflow Builder (drag-and-drop)
- [ ] Custom Domain Wizard (7-step)
- [ ] Auto-updater, code signing, packaging

## Security & Production (Ongoing)

- [ ] `tauri-plugin-stronghold` for secret storage (API keys)
- [ ] System tray + single-instance enforcement
- [ ] Global hotkey registration
- [ ] Local data encryption at rest
- [ ] State migration versioning and rollback
- [ ] Auto-update via Tauri's updater plugin

---

## Resolved Technical Debt

| Item | Resolution |
|---|---|
| Raw Memgraph node serialization | Fixed — `normalizeNode()` in `_helpers.ts` applied to all routes |
| Tests using `props()`/`num()` workarounds | Fixed — tests use direct property access |
| Sprint 1 E2E test flakiness | Resolved — graceful truncation handling for CPU-bound LLM inference |

## Remaining Technical Debt

| Item | Severity | Location | Notes |
|---|---|---|---|
| `@memflow/shared` not yet consumed by backend | Low | `packages/shared/` | Schemas exist but backend routes use inline Zod |
| `fflate` type declaration missing | Low | `DOCXSpatialParser.ts` | Pre-existing; works at runtime |
| `cmdk` peer dependency warning | Low | `packages/desktop-app/` | Monitor React 19 compatibility |

## Quick Start

```bash
# 1. Start infrastructure
docker compose -f docker/docker-compose.yml --profile cpu up -d

# 2. Start the MemFlow backend (watch mode)
bun run dev

# 3. Verify endpoints (Phase 1 + Phase 2)
curl http://localhost:3000/health
curl http://localhost:3000/api/v1/solutions
curl http://localhost:3000/api/v1/workflows/catalog
curl http://localhost:3000/api/v1/graph/stats
curl http://localhost:3000/api/v1/modules/schemas
curl http://localhost:3000/api/v1/executions
curl http://localhost:3000/api/v1/gmpl/patterns
curl http://localhost:3000/api/v1/gmpl/roles

# 4. Run integration tests
bun test src/tests/integration/real-services/desktop-api-real.test.ts
bun test src/tests/integration/real-services/chat-e2e.test.ts

# 5. Launch Tauri desktop app (requires Rust toolchain in PATH)
cd packages/desktop-app
bun run tauri dev   # ~1m42s first build, then instant hot-reload
```
