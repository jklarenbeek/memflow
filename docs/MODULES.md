# MemFlow Module System (v0.5.1)

> How the WorkflowEngine, ModuleRegistry, GMPL, and Sub-Workflow system combine 69 modules into composable research-aligned pipelines.

---

## Overview

MemFlow decomposes complex RAG capabilities into **atomic modules** — small, focused units that each do exactly one thing. These modules are composed into **sub-workflows** — JSON-described DAGs — and invoked from parent workflows via the `SubWorkflow` engine module.

This architecture enables:

- **Workflow-level composition**: Any combination of atomic modules can be wired into a pipeline via JSON configuration, with no code changes required.
- **Backward compatibility**: Composite wrapper modules (SimpleMem, LightMem, StructMem, etc.) present the same interface as the original monolithic modules, delegating all logic to sub-workflows internally.
- **Config-over-code**: Sub-workflow behavior is tuned entirely through per-stage config overrides (`_stageConfigs`), not through module source modifications.
- **Shared context**: Sub-workflows reuse the parent engine's `WorkflowContext` (Memgraph connection, LLM/Embedding providers, StateStore, Logger), preventing resource duplication.

## WorkflowEngine

The `WorkflowEngine` is the DAG executor at the heart of MemFlow. It reads a JSON workflow configuration and orchestrates the execution of stages:

1. **Parse** the JSON config and validate it with Zod
2. **Initialize** the `WorkflowContext` (DI container) and validate all module configs (fail-fast)
3. **Execute** stages according to the DAG: sequential, parallel (`Promise.allSettled`), conditional routing, or sub-workflow delegation
4. **Track** the current stage for accurate error reporting
5. **Emit** typed events via `WorkflowEventEmitter` for SSE streaming and Prometheus metrics
6. **Shutdown** all modules and context resources

Key capabilities:

| Feature | Description |
|---|---|
| Parallel branches | `next: ["a", "b"]` executes stages concurrently; `dependsOn` gates execution |
| Conditional routing | `next: { "confidence>0.8": "cite", "default": "clarify" }` |
| Sub-workflows | `module: "SubWorkflow"` nests a child engine with shared context |
| Stage config overrides | `_stageConfigs` mechanism for per-stage tuning in sub-workflows |
| Retry | Exponential backoff per stage |
| Learning loops | Iterative re-execution with composite scoring |
| Streaming | `runStream()` yields `StreamEvent` objects for real-time SSE |

## ModuleRegistry

The `ModuleRegistry` is a singleton factory that manages all 69 registered modules:

- **Lazy loading**: Modules are loaded via dynamic `import()` on first use — no upfront loading penalty
- **Instance caching**: Instances are keyed by `moduleName::stageId` to ensure stateful modules maintain their state across stages
- **Runtime plugins**: `register(name, Class)` allows runtime extension with custom modules
- **Validation**: `clearInstances()` resets the cache between validation and execution passes

## Sub-Workflow System

Sub-workflows are the primary composition mechanism. Any workflow stage can delegate to a child pipeline:

```json
{
  "id": "retrieve",
  "module": "SubWorkflow",
  "workflowRef": "src/workflows/sub/hybrid-retrieval.json",
  "inputMap": { "query": "query" },
  "outputMap": { "retrievalResult": "retrievalResult" },
  "next": "generate"
}
```

The `SubWorkflowModule` reads `_stageConfigs` from the parent input data and applies them to the child engine via `setStageConfigOverrides()` before initialization. This enables composite wrappers to fine-tune individual stage configs without modifying sub-workflow JSON files.

Fourteen pre-built sub-workflows are provided in `src/workflows/sub/`:

| Sub-Workflow | Pipeline | Paper |
|---|---|---|
| [`simplemem-pipeline.json`](modules/simplemem.md) | Window → Gate → Extract → Synthesize → Index | SimpleMem §2 |
| [`simplemem-retrieval.json`](modules/simplemem.md) | Plan → [Sem ∥ Lex ∥ Sym] → Rank | SimpleMem §2.3 |
| [`lightmem-pipeline.json`](modules/lightmem.md) | PreCompress → Buffer → [cond] → Novelty → Segment → STM → Consolidate | LightMem |
| [`structmem-pipeline.json`](modules/structmem.md) | DualPersp → Consolidate → Persist | StructMem |
| [`hera-orchestration.json`](modules/hera.md) | Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize | HERA |
| [`hybrid-retrieval.json`](modules/retrieval.md) | Intent → [Vector ∥ Graph ∥ Keyword] → Rank | LightRAG |
| [`graph-indexing.json`](modules/graph.md) | Ingest → Extract → Dedup → Profile → Community | LightRAG §3.1 |
| [`priha-fusion.json`](modules/priha.md) | Clarify → Generate → Validate → Cite | PriHA |
| [`patterns/structured-debate.json`](modules/gmpl.md) | DebateModule → ConsensusJudge → FinalSynthesizer | TradingAgents |
| [`patterns/clarification-pipeline.json`](modules/gmpl.md) | MultiTurnClarifier → QueryClarifier → WebSearch → DualSourceFusion → Generate → Validate → Cite | PriHA + GMPL |
| [`patterns/parallel-analysis.json`](modules/gmpl.md) | ParallelDispatcher → FinalSynthesizer | TradingAgents |
| [`patterns/peer-review.json`](modules/gmpl.md) | PeerReviewModule → FinalSynthesizer | GMPL |
| [`patterns/red-team.json`](modules/gmpl.md) | RedTeamModule → FinalSynthesizer | GMPL |
| [`patterns/delphi-panel.json`](modules/gmpl.md) | DelphiPanelModule → FinalSynthesizer | GMPL |

## Pipeline Reference

Detailed per-module documentation (input/output fingerprints, config schemas, paper traceability) is organized by pipeline:

| Pipeline | Doc | Atomic Modules | Wrapper |
|---|---|---|---|
| **SimpleMem** | [simplemem.md](modules/simplemem.md) | SlidingWindow, DensityGate, FactExtractor, SemanticSynthesis, StructuredIndex, IntentAwarePlanner | `SimpleMem` |
| **LightMem** | [lightmem.md](modules/lightmem.md) | PreCompression, SensoryBuffer, NoveltyGate, TopicSegmenter, AttentionScore, STMBuffer, SleepConsolidation | `LightMem` |
| **StructMem** | [structmem.md](modules/structmem.md) | DualPerspective, CrossEventConsolidation, GraphPersist | `StructMem` |
| **Retrieval** | [retrieval.md](modules/retrieval.md) | IntentClassifier, DualLevelRouter, VectorSearch, GraphSearch, KeywordSearch, SymbolicSearch, ResultRanker, SetUnionMerger | `LightRAGRetriever` |
| **HERA Agents** | [hera.md](modules/hera.md) | PlanGenerator, TrajectoryExecutor, RewardComputer, ExperienceReflector, RoPEEvolver, TopologyMutator, FinalSynthesizer | `HERAOrchestrator` |
| **Graph Indexing** | [graph.md](modules/graph.md) | ChunkIngestor, EntityExtractor, EntityDeduplicator, EntityProfiler, CommunityDetector | `MemgraphGraph` |
| **PriHA Generation** | [priha.md](modules/priha.md) | QueryClarifier, AnswerGenerator, HallucinationValidator, CitationInjector, WebSearchAgent, DualSourceFusion | `PriHAFusion` |
| **GMPL Patterns** | [gmpl.md](modules/gmpl.md) | DebateModule, ConsensusJudge, MultiTurnClarifier, ParallelDispatcher, OutcomeMemory, PeerReviewModule, RedTeamModule, DelphiPanelModule | — |

## Standalone Modules

These modules operate independently outside of the sub-workflow pipelines:

| Module | Description |
|---|---|
| **S2Chunker** | Spectral clustering chunking on spatial+semantic affinity (extends LangChain `TextSplitter`) |
| **MarkdownSpatialParser** | Converts Markdown into spatial elements with layout-aware position metadata |
| **ParentChildChunker** | Two-tier chunking with `:BELONGS_TO` graph edges for parent-child retrieval |
| **QueryTranslator** | Five strategies: HyDE, Multi-Query, Step-Back, Query Rewriting, Intent Clarification |
| **AutonomousLoop** | Iterative diagnosis → mutation → re-execution loop (OMNI-SIMPLEMEM §3) |
| **Embedder** | LangChain embedding provider (Ollama / OpenAI / OpenRouter) |
| **LLMProvider** | LangChain chat model provider (Ollama / OpenAI / OpenRouter) |

## Advanced Modules

| Module | Description |
|---|---|
| **AgentContext** | Shared context container for multi-agent workflows |
| **OutcomeLearner** | Outcome-based learning signal extraction |
| **Crystallizer** | Memory crystallization for long-term knowledge distillation |
| **Contradiction** | Contradiction detection and resolution across memory units |

## Example Workflows

Three top-level example workflows demonstrate how the sub-workflow system composes pipelines:

| Workflow | Stages | Use Case |
|---|---|---|
| `rag-memory-pipeline.json` | translate → parse → chunk → embed → graph → SimpleMem → LightMem → StructMem → retrieve → fuse | Full 10-stage RAG pipeline |
| `quick-qa.json` | translate → embed → retrieve → fuse | Minimal 4-stage QA |
| `multi-agent-research.json` | parallel retrieval → HERA with learning + RoPE + topology mutation | Autonomous multi-agent research |
