# StructMem Pipeline

> **Paper**: StructMem §3  
> **Composite Wrapper**: `StructMemModule` (`modules/memory/StructMemModule.ts`)  
> **Sub-Workflow**: `structmem-pipeline.json` — DualPerspective → CrossEventConsolidation → GraphPersist

The StructMem pipeline implements the third stage of the memory architecture (SimpleMem → LightMem → StructMem). It enriches memory units with temporal anchoring and entity metadata, performs cross-event consolidation to discover inter-memory relationships, and persists the enriched graph to Memgraph.

The `StructMemModule` wrapper retains the stateful event buffer and consolidation trigger logic (buffer size OR time elapsed) that determines when to invoke the sub-workflow. The algorithmic logic (sort, seed, synthesize, bind, persist) is fully delegated to the atomic modules.

**Config (wrapper)**:
- `relationThreshold` (0.7) — cosine threshold for linking related memories
- `persistToGraph` (true) — whether to persist to Memgraph
- `persistBatchSize` (50) — max recent memories to batch-persist
- `consolidationThreshold` (10) — buffer size threshold to trigger cross-event consolidation
- `consolidationIntervalMs` (60000) — time in ms since last consolidation before forcing a trigger

---

## Atomic Modules

### DualPerspective

| | |
|---|---|
| **File** | `modules/memory/DualPerspectiveModule.ts` |
| **Paper** | StructMem §3.1 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (enriched with temporal + entity metadata) |

Enriches units with temporal anchoring (ISO timestamps from content) and entity extraction (named entities, event types, interactional relations). LLM-driven with regex NER fallback.

### CrossEventConsolidation

| | |
|---|---|
| **File** | `modules/memory/CrossEventConsolidationModule.ts` |
| **Paper** | StructMem §3.2 |
| **Input** | `memoryUnits` |
| **Output** | `memoryUnits` (with cross-event relations) |
| **Config** | `relationThreshold`, `seedCount`, `timeWindowMs`, `seedSearchWindow`, `similarityFunction` |

Full Cbuf = Sortτ pipeline: temporally sort buffer → compute aggregated centroid query → retrieve time-bounded seed entries → LLM synthesizes cross-event connections. Fallback: pairwise similarity binding with typed relation inference when the LLM returns zero connections. Configurable similarity function via strategy pattern.

### GraphPersist

| | |
|---|---|
| **File** | `modules/memory/GraphPersistModule.ts` |
| **Paper** | StructMem |
| **Input** | `memoryUnits` |
| **Output** | (none — side-effect only) |
| **Side-effects** | Writes `:MemoryUnit` nodes and `:MEMORY_RELATION` edges to Memgraph (via `batchQuery()` UNWIND) |
| **Config** | `batchSize`, `dryRun` |
