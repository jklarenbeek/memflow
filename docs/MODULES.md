# MemFlow Module System (v0.5.1)

> How the WorkflowEngine, ModuleRegistry, GMPL, and Sub-Workflow system combine 80 modules into composable research-aligned pipelines.

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

The `ModuleRegistry` is a singleton factory that manages all 80 registered modules:

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

Eighteen pre-built sub-workflows are provided in `src/workflows/sub/`:

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
| [`trace2skill-pipeline.json`](modules/evolution.md) | TraceCluster → SkillMerge (→ persist to graph) | Trace2Skill + AutoSkill |
| [`slm-dataset-export.json`](modules/evolution.md) | SLMDatasetExporter | Memo |
| [`harness-evolution.json`](modules/evolution.md) | HarnessEvolver | Milkyway |
| [`intent-compiler.json`](modules/evolution.md) | IntentCompiler | LSE |

## Pipeline Reference

Detailed per-module documentation (input/output fingerprints, config schemas, paper traceability) is organized by pipeline:

| Pipeline | Doc | Atomic Modules | Wrapper |
|---|---|---|---|
| **Chunking** | [chunking.md](modules/chunking.md) | S2Chunker, MarkdownSpatialParser, PDFSpatialParser, DOCXSpatialParser, ParentChildChunker | — |
| **SimpleMem** | [simplemem.md](modules/simplemem.md) | SlidingWindow, DensityGate, FactExtractor, SemanticSynthesis, StructuredIndex, IntentAwarePlanner | `SimpleMem` |
| **LightMem** | [lightmem.md](modules/lightmem.md) | PreCompression, SensoryBuffer, NoveltyGate, TopicSegmenter, AttentionScore, STMBuffer, SleepConsolidation | `LightMem` |
| **StructMem** | [structmem.md](modules/structmem.md) | DualPerspective, CrossEventConsolidation, GraphPersist | `StructMem` |
| **Retrieval** | [retrieval.md](modules/retrieval.md) | IntentClassifier, DualLevelRouter, VectorSearch, GraphSearch, KeywordSearch, SymbolicSearch, ResultRanker, SetUnionMerger | `LightRAGRetriever` |
| **HERA Agents** | [hera.md](modules/hera.md) | PlanGenerator, TrajectoryExecutor, RewardComputer, ExperienceReflector, RoPEEvolver, TopologyMutator, FinalSynthesizer | `HERAOrchestrator` |
| **Graph Indexing** | [graph.md](modules/graph.md) | ChunkIngestor, EntityExtractor, EntityDeduplicator, EntityProfiler, CommunityDetector | `MemgraphGraph` |
| **PriHA Generation** | [priha.md](modules/priha.md) | QueryClarifier, AnswerGenerator, HallucinationValidator, CitationInjector, WebSearchAgent, DualSourceFusion | `PriHAFusion` |
| **GMPL Patterns** | [gmpl.md](modules/gmpl.md) | DebateModule, ConsensusJudge, MultiTurnClarifier, ParallelDispatcher, OutcomeMemory, PeerReviewModule, RedTeamModule, DelphiPanelModule | — |
| **Evolution** | [evolution.md](modules/evolution.md) | SLMDatasetExporter, TraceCluster, SkillMerge, SkillInjector, Trace2Skill, HarnessEvolver, IntentCompiler, SkillBasisExtractor, SkillGapAnalyzer | — |
| **Trading Domain** | [GMPL_TUTORIAL.md](GMPL_TUTORIAL.md) | `tradingAdapter`, `registerTradingRoles()`, 7 entity schemas, 5 prompt packs | — |

## Standalone Modules

These modules operate independently outside of the sub-workflow pipelines:

| Module | Description | Deep Dive |
|---|---|---|
| **S2Chunker** | Spectral clustering chunking on spatial+semantic affinity (extends LangChain `TextSplitter`) | [chunking.md](modules/chunking.md) |
| **MarkdownSpatialParser** | Converts Markdown into spatial elements with layout-aware position metadata | [chunking.md](modules/chunking.md) |
| **PDFSpatialParser** | Extracts text + bounding boxes from PDFs via `unpdf`, produces layout-aware Documents for S2 clustering | [chunking.md](modules/chunking.md) |
| **ParentChildChunker** | Two-tier chunking with `:BELONGS_TO` graph edges for parent-child retrieval | [chunking.md](modules/chunking.md) |
| **DOCXSpatialParser** | Extracts text + layout structure from DOCX files via `officeparser`, produces layout-aware Documents with spatial coordinates for S2 clustering | [chunking.md](modules/chunking.md) |
| **QueryTranslator** | Five strategies: HyDE, Multi-Query, Step-Back, Query Rewriting, Intent Clarification | — |
| **AutonomousLoop** | Iterative diagnosis → mutation → re-execution loop (OMNI-SIMPLEMEM §3) | — |
| **Embedder** | LangChain embedding provider (Ollama / OpenAI / OpenRouter) | — |
| **LLMProvider** | LangChain chat model provider (Ollama / OpenAI / OpenRouter) | — |

## Advanced Modules

| Module | Description |
|---|---|
| **AgentContext** | Shared context container for multi-agent workflows |
| **OutcomeLearner** | Outcome-based learning signal extraction |
| **Crystallizer** | Memory crystallization for long-term knowledge distillation |
| **Contradiction** | Contradiction detection and resolution across memory units |

## Evolution Modules

The Self-Evolution Layer adds 9 modules for autonomous skill distillation, dataset export, and workflow compilation:

| Module | Description | Deep Dive |
|---|---|---|
| **SLMDatasetExporter** | Exports GMPL session data as SFT/DPO training samples for downstream SLM fine-tuning | [evolution.md](modules/evolution.md) |
| **TraceCluster** | Clusters experience library entries via k-means on embeddings | [evolution.md](modules/evolution.md) |
| **SkillMerge** | LLM-powered merging of trace clusters into declarative skill artifacts | [evolution.md](modules/evolution.md) |
| **SkillInjector** | Retrieves relevant skills from Memgraph by vector similarity and injects into context | [evolution.md](modules/evolution.md) |
| **Trace2Skill** | Orchestrates the full TraceCluster → SkillMerge pipeline via `ctx.runSubWorkflow()` | [evolution.md](modules/evolution.md) |
| **HarnessEvolver** | Maintains versioned prediction harnesses with retrospective validation (Milkyway) | [evolution.md](modules/evolution.md) |
| **IntentCompiler** | Compiles natural language intents into executable workflow JSON | [evolution.md](modules/evolution.md) |
| **SkillBasisExtractor** | PCA-based embedding space decomposition for skill characterization | [evolution.md](modules/evolution.md) |
| **SkillGapAnalyzer** | Projects experience library onto skill basis to identify coverage gaps | [evolution.md](modules/evolution.md) |

## Example Workflows

Nine top-level example workflows demonstrate how the sub-workflow system composes pipelines:

| Workflow | Stages | Use Case |
|---|---|---|
| `rag-memory-pipeline.json` | translate → parse → chunk → embed → graph → SimpleMem → LightMem → StructMem → retrieve → fuse | Full 10-stage RAG pipeline |
| `quick-qa.json` | translate → embed → retrieve → fuse | Minimal 4-stage QA |
| `multi-agent-research.json` | parallel retrieval → HERA with learning + RoPE + topology mutation | Autonomous multi-agent research |
| `trading-analysis.json` | parallel analyst dispatch → bull/bear debate → risk debate → outcome logging | TradingAgents-inspired multi-pattern pipeline |
| `healthcare-assistant.json` | multi-turn clarification → retrieval → DualSourceFusion → peer review → generation | Clinical assistant with medical authority safelist |
| `autonomous-research.json` | parallel analysis → Delphi expert consensus → red team validation → outcome memory | 4-pattern autonomous research pipeline |
| `self-improving-research.json` | HERA + Trace2Skill + SkillInjector learning loop | Self-improving agent with skill distillation |
| `skill-distillation-batch.json` | TraceCluster → SkillMerge → SkillBasisExtractor → SkillGapAnalyzer | Batch skill analytics pipeline |
| `trading-harness-evolution.json` | HarnessEvolver for trading domain prediction harnesses | Milkyway-inspired market prediction |

## Trading Domain Adapter

Reference implementation of the `DomainAdapter` contract in `src/domains/trading/`, based on TradingAgents (arXiv:2412.20138v7). Demonstrates the full plugin lifecycle:

| Component | File | Detail |
|---|---|---|
| Entity schemas | `schemas.ts` | 7 Zod schemas: Ticker, Sector, EarningsReport, TechnicalIndicator, MarketData, SentimentData, NewsEvent |
| Data providers | `adapter.ts` | `getMarketData()`, `getEarningsReport()`, `getSentiment()`, `getTechnicalIndicators()` |
| Outcome evaluator | `adapter.ts` | Direction + tolerance comparison (success/partial/failure) |
| Metrics calculator | `adapter.ts` | Sharpe Ratio, Maximum Drawdown, Win Rate |
| Extended roles | `roles.ts` | 4 roles via `RoleRegistry.extend()` from core analyst roles: fundamentals, technical, sentiment, risk |
| Prompt packs | `src/prompts/trading/` | 5 TOML files: fundamentals, technical, sentiment, debate, research |
| Seed knowledge | `adapter.ts` | 11 S&P 500 sectors + 4 major indices |

See [GMPL_TUTORIAL.md](GMPL_TUTORIAL.md) for a step-by-step guide to building a domain adapter.
