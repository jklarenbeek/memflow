# Graph Indexing Pipeline

> **Paper**: LightRAG §3.1  
> **Composite Wrapper**: `MemgraphGraphModule` (`modules/graph/MemgraphGraphModule.ts`)  
> **Sub-Workflow**: `graph-indexing.json` — ChunkIngestor → EntityExtractor → EntityDeduplicator → EntityProfiler → CommunityDetector

The graph indexing pipeline converts raw document chunks into a structured knowledge graph in Memgraph. It ingests chunks as nodes, extracts entities and relationships via LLM, deduplicates entities against the existing graph, generates entity profiles, and runs community detection to discover thematic clusters.

The `MemgraphGraphModule` wrapper delegates all logic to the `graph-indexing.json` sub-workflow. Its `buildStageConfigs()` distributes the flat config surface (e.g., `communityAlgorithm`, `generateSummaries`) onto per-stage overrides.

**Config (wrapper)**:
- `communityAlgorithm` (`louvain` / `leiden`)
- `generateSummaries` (true) — whether to LLM-generate community summaries
- `checkExistingGraph` (true) — dedup against existing entities in Memgraph

---

## Atomic Modules

### ChunkIngestor

| | |
|---|---|
| **File** | `modules/graph/ChunkIngestorModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `chunks`, `embeddings` |
| **Output** | (side-effect: `:Chunk` nodes in Memgraph) |

MERGEs chunk nodes into Memgraph. Uses `batchQuery()` UNWIND for N→1 batch ingestion. Emits `memgraphQueries` telemetry counter.

### EntityExtractor

| | |
|---|---|
| **File** | `modules/graph/EntityExtractorModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `chunks` |
| **Output** | `entities`, `relationships` |

LLM entity/relationship extraction via TOML prompt with structured JSON output.

### EntityDeduplicator

| | |
|---|---|
| **File** | `modules/graph/EntityDeduplicatorModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `entities` |
| **Output** | `entities` (canonical) |
| **Config** | `useLLM`, `checkExistingGraph` |

LLM-based canonical name resolution. `checkExistingGraph` queries Memgraph for existing entities before dedup — ensures true incremental graph updates without rebuilding.

### EntityProfiler

| | |
|---|---|
| **File** | `modules/graph/EntityProfilerModule.ts` |
| **Paper** | LightRAG §3.1 |
| **Input** | `entities`, `chunks` |
| **Output** | `entities` (with `profileSummary`, `keyThemes`) |

LLM-generated entity profiles with key themes for enriched graph context.

### CommunityDetector

| | |
|---|---|
| **File** | `modules/graph/CommunityDetectorModule.ts` |
| **Paper** | LightRAG |
| **Input** | (graph state) |
| **Output** | `communities`, `communitySummaries` |
| **Side-effects** | Writes `communityId` to `:Entity` nodes, creates `:Community` nodes |
| **Config** | `algorithm` (`louvain` / `leiden`), `weight`, `coloring`, `minGraphShrink`, `communityAlgThreshold`, `gamma`, `theta`, `generateSummaries`, `maxSummaries` |

Runs MAGE community detection: Louvain (`community_detection.get()`, O(n log n)) or Leiden (`leiden_community_detection.get()`, O(L·m)). Writes community labels via `batchQuery()` UNWIND, generates LLM summaries, persists `:Community` nodes for high-level retrieval.
