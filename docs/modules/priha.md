# PriHA Generation Pipeline

> **Paper**: PriHA  
> **Composite Wrapper**: `PriHAFusionModule` (`modules/generation/PriHAFusionModule.ts`)  
> **Sub-Workflow**: `priha-fusion.json` — QueryClarifier → AnswerGenerator → HallucinationValidator → CitationInjector  
> **Related**: `DualSourceFusionModule` for dual-source reconciliation

The PriHA pipeline implements the full generation path: iterative query clarification (PHC-O), dual-source answer generation, hallucination validation, and traceable citation injection. It is the standard answer generation pipeline used downstream of hybrid retrieval.

The `PriHAFusionModule` wrapper delegates all logic to the `priha-fusion.json` sub-workflow.

**Config (wrapper)**:
- `enableDualSource` (true) — enable dual-source fusion (official + dynamic context)
- `enableValidation` (true) — enable hallucination validation pass
- `citationStyle` (`inline` / `footnote`)

---

## Atomic Modules

### QueryClarifier

| | |
|---|---|
| **File** | `modules/generation/QueryClarifierModule.ts` |
| **Paper** | PriHA (PHC-O) |
| **Input** | `query` |
| **Output** | `query` (refined), `clarifications` |

Iterative query decomposition and optimization.

### AnswerGenerator

| | |
|---|---|
| **File** | `modules/generation/AnswerGeneratorModule.ts` |
| **Paper** | PriHA §3.4 |
| **Input** | `query`, `retrievalResult`, `finalAnswer` (optional draft) |
| **Output** | `finalAnswer`, `sources`, `confidence` |
| **Config** | `enableDualSource` (true), `maxContextTokens` (7000) |
| **Streaming** | ✅ `processStream()` via LangChain `.stream()` |

Dual-source fusion (official guidelines + dynamic context) → LLM generation. Supports draft refinement mode when `finalAnswer` is already set. Implements `StreamableModule` for real-time token streaming via SSE.

### HallucinationValidator

| | |
|---|---|
| **File** | `modules/generation/HallucinationValidatorModule.ts` |
| **Paper** | PriHA |
| **Input** | `finalAnswer` |
| **Output** | `finalAnswer` (validated), `confidence` |

LLM-based hallucination detection and confidence scoring.

### CitationInjector

| | |
|---|---|
| **File** | `modules/generation/CitationInjectorModule.ts` |
| **Paper** | PriHA |
| **Input** | `finalAnswer`, `sources` |
| **Output** | `finalAnswer` (cited) |
| **Side-effects** | Creates `:Answer` and `:Citation` nodes with `:CITES` edges in Memgraph |
| **Config** | `style` (`inline` / `footnote`), `maxCitations`, `persistCitations` |

Inline/footnote citation injection with Memgraph persistence. Uses `batchQuery()` UNWIND for batch citation creation (N+1→2 round-trips).

### WebSearchAgent (stub)

| | |
|---|---|
| **File** | `modules/generation/WebSearchAgentModule.ts` |
| **Paper** | PriHA §3.3 |
| **Input** | `query`, `expandedQueries` |
| **Output** | `webContext`, `webSources`, `webSearchCompleted` (always `false`) |
| **Config** | `maxResults`, `searchProvider`, `urlSafelist` |

Stub awaiting search API provider integration. The DualSourceFusion module depends on this module.

### DualSourceFusion

| | |
|---|---|
| **File** | `modules/generation/DualSourceFusionModule.ts` |
| **Paper** | PriHA §3.4 |
| **Input** | `retrievalResult`, `webContext`, `webSources` |
| **Output** | `fusedContext`, `sources` |
| **Config** | `localWeight` (0.6), `authorityBoost` (1.3), `stalenessPenalty` (0.05), `maxContextChars` (6000) |

Dual-source reconciliation: fuses local KB context (CLocal) with web context (CWeb). Applies source priority scoring (official > academic > general web), temporal freshness weighting, and budget-gated segment ranking. Domain-agnostic — usable in any domain, not just healthcare or finance.
