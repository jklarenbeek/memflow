# SimpleMem Pipeline

> **Paper**: SimpleMem §2  
> **Composite Wrapper**: `SimpleMemModule` (`modules/memory/SimpleMemModule.ts`)  
> **Sub-Workflow (write)**: `simplemem-pipeline.json` — Window → Gate → Extract → Synthesize → Index  
> **Sub-Workflow (read)**: `simplemem-retrieval.json` — Plan → [Sem ∥ Lex ∥ Sym] → Rank

The SimpleMem pipeline implements the first stage of the three-tier memory architecture (SimpleMem → LightMem → StructMem). It converts raw document chunks into typed `MemoryUnit` objects via sliding-window processing, semantic density gating, LLM fact extraction, cosine-based synthesis, and multi-view indexing.

The `SimpleMemModule` wrapper delegates all logic to the `simplemem-pipeline.json` sub-workflow. It maps its flat config surface onto per-stage overrides via `buildStageConfigs()`, which are passed to the child engine through the `_stageConfigs` mechanism.

**Config (wrapper)**:
- `synthesisThreshold` (0.82) — cosine similarity threshold for merging similar memories
- `compressionRatio` (0.3) — compression ratio target
- `windowSize` (5) — chunks per sliding window
- `windowOverlap` (2) — overlap between adjacent windows
- `enableDensityGating` (true) — enable semantic density gating (paper Eq. 1)

---

## Atomic Modules

### SlidingWindow

| | |
|---|---|
| **File** | `modules/memory/SlidingWindowModule.ts` |
| **Input** | `chunks` |
| **Output** | `windowedChunks` |
| **Config** | `windowSize`, `windowOverlap` |

Groups chunks into overlapping temporal windows for context-preserving downstream processing.

### DensityGate

| | |
|---|---|
| **File** | `modules/memory/DensityGateModule.ts` |
| **Input** | `windowedChunks` |
| **Output** | `filteredChunks` |
| **Config** | `minFactCount` |

Implements Φ_gate(W) — LLM-based semantic density evaluation with heuristic fallback. Only windows with `≥ minFactCount` distinct facts pass through.

### FactExtractor

| | |
|---|---|
| **File** | `modules/memory/FactExtractorModule.ts` |
| **Input** | `filteredChunks` |
| **Output** | `memoryUnits` |

LLM de-linearisation of text into typed `MemoryUnit` objects with batch embedding. Supports coreference resolution via the extraction TOML prompt. Populates `modelId` and `providerId` from `WorkflowContext.globalConfig` for provenance tracking. Emits `embeddingCalls` and `tokenUsage` telemetry counters.

### SemanticSynthesis

| | |
|---|---|
| **File** | `modules/memory/SemanticSynthesisModule.ts` |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (merged) |
| **Config** | `synthesisThreshold` (0.82), `useLLM` (true), `similarityFunction` (`cosine` / `euclidean` / `dotProduct`) |

Cosine-based merge of highly similar units (strictly `> threshold`). Averages embeddings and combines content. Configurable similarity function allows switching between cosine, euclidean, and dot product strategies for cluster detection.

### StructuredIndex

| | |
|---|---|
| **File** | `modules/memory/StructuredIndexModule.ts` |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (enriched with lexical + symbolic metadata) |

Multi-view indexing: enriches each unit with TF-based lexical keywords and structured symbolic metadata (type, timestamp, confidence) for complementary retrieval paths.

### IntentAwarePlanner

| | |
|---|---|
| **File** | `modules/memory/IntentAwarePlannerModule.ts` |
| **Paper** | SimpleMem §2.3 |
| **Input** | `query`, `memoryUnits` |
| **Output** | `expandedQueries`, `semanticQuery`, `lexicalQuery`, `symbolicFilter`, `retrievalDepth` |

Decomposes query into three complementary retrieval signals — `{qₛₑₘ, qₗₑₓ, qₛᵧₘ, d}` — where `d` is adaptive retrieval depth. LLM with heuristic fallback. Used in the `simplemem-retrieval.json` read path.
