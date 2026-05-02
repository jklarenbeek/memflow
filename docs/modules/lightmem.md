# LightMem Pipeline

> **Paper**: LightMem §3.1–3.3  
> **Composite Wrapper**: `LightMemModule` (`modules/memory/LightMemModule.ts`)  
> **Sub-Workflow**: `lightmem-pipeline.json` — PreCompress → SensoryBuffer → [cond] → NoveltyGate → TopicSegmenter → STMBuffer → SleepConsolidation

The LightMem pipeline implements all three tiers of the LightMem paper: Light₁ (compression + sensory buffer), Light₂ (novelty filtering + topic segmentation + STM), and Light₃ (sleep consolidation into LTM).

The `LightMemModule` wrapper retains the sensory buffer capacity logic and delegates pipeline execution to the `lightmem-pipeline.json` sub-workflow. It hardcodes `sensory_buffer.bufferCapacity: 1` in `buildStageConfigs()` to ensure sub-workflow batches always flush through the pipeline, and forwards child workflow metrics (`flushMetrics`, `consolMetrics`) to the parent.

The LightMem pipeline uses conditional routing at the `sensory_buffer` stage: when the buffer is above 50% capacity, data routes to the standard `novelty` gate; otherwise, a `passthrough` stage with `noveltyThreshold: 1.0` ensures small batches continue through to the `segment` stage.

**Config (wrapper)**:
- `noveltyThreshold` (0.75) — cosine similarity threshold for filtering redundant memories
- `sensoryBufferSize` (512) — token capacity before sensory buffer flushes
- `maxMemoryUnits` (1000) — LTM capacity
- `consolidationTrigger` (0.8) — fraction of capacity that triggers sleep consolidation
- `compressionRatio` (0.3) — target compression ratio for pre-compression

---

## Atomic Modules

### PreCompression

| | |
|---|---|
| **File** | `modules/memory/PreCompressionModule.ts` |
| **Paper** | LightMem §3.1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (compressed, redundancy removed) |

LLM-based cross-entropy density scoring per sentence (approximates Python-only LLMLingua-2). Retains only sentences above the τ-percentile threshold.

### SensoryBuffer

| | |
|---|---|
| **File** | `modules/memory/SensoryBufferModule.ts` |
| **Paper** | LightMem §3.1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (flushed when buffer ≥ th tokens, `[]` otherwise) |
| **Side-effects** | Crash-recoverable Memgraph-backed buffer state |

Accumulates compressed units until capacity `th` tokens is reached, then flushes downstream.

### NoveltyGate

| | |
|---|---|
| **File** | `modules/memory/NoveltyGateModule.ts` |
| **Paper** | LightMem Tier 1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (novel only) |
| **Config** | `noveltyThreshold`, `similarityFunction` (`cosine` / `euclidean` / `dotProduct`) |

Similarity filtering against existing memories. Checks both existing units and already-accepted batch units to prevent intra-batch duplicates. Configurable similarity function allows switching between strategies.

### TopicSegmenter

| | |
|---|---|
| **File** | `modules/memory/TopicSegmenterModule.ts` |
| **Paper** | LightMem §3.2 |
| **Input** | `memoryUnits` |
| **Output** | `topicSegments` |
| **Config** | `topicSimilarityThreshold`, `minSegmentSize`, `similarityFunction` |

Hybrid B1∩B2 boundary detection — B1 = local similarity minima (or attention scores from `AttentionScoreModule`); B2 = threshold drops. Final boundaries = B1∩B2 with B2 fallback. Small segments merged into adjacent. Derives `topicLabel` for each segment using entity-based or keyword-based heuristics.

### AttentionScore

| | |
|---|---|
| **File** | `modules/memory/AttentionScoreModule.ts` |
| **Paper** | LightMem §3.2 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (with `metadata.attentionBoundaryScore`) |

LLM-based approximation of LLMLingua-2 attention scores. Produces `attentionBoundaryScore` metadata for `TopicSegmenter` B1 signal. Opt-in; inserted before TopicSegmenter.

### STMBuffer

| | |
|---|---|
| **File** | `modules/memory/STMBufferModule.ts` |
| **Paper** | LightMem §3.2 |
| **Input** | `topicSegments` |
| **Output** | `memoryUnits` (LTM-promoted: `{topic, eᵢ, userᵢ, modelᵢ}`) |

Accumulates topic segments and promotes to LTM format when capacity is reached.

### SleepConsolidation

| | |
|---|---|
| **File** | `modules/memory/SleepConsolidationModule.ts` |
| **Paper** | LightMem §3.3 |
| **Input** | `topicSegments` |
| **Output** | `memoryUnits` (LTM) |
| **Config** | `ltmMaxSize`, `softUpdateThreshold`, `updateQueueSize`, `enableOfflineQueues`, `similarityFunction` |

Parallel LLM summarization of topic segments. Per-entry update queues `Q(eᵢ) = Topk({eⱼ, sim(vᵢ, vⱼ)} | tⱼ ≥ tᵢ)` with `Promise.allSettled`. Soft-update LTM: `newTs >= existingTs` constraint. Legacy sequential mode available via `enableOfflineQueues: false`. Configurable similarity function via strategy pattern.
