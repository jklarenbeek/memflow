# Chunking Modules

> Layout-aware document segmentation for high-quality RAG chunk production.

---

## Overview

MemFlow provides five chunking modules that transform raw documents into semantically coherent, token-bounded chunks. At the core is the **S2Chunker** — a spectral-clustering chunker based on the arXiv paper "S2 Chunking: A Hybrid Framework for Document Segmentation Through Integrated Spatial and Semantic Analysis" (Verma 2025, arXiv:2501.05485v1). Three spatial parsers (**MarkdownSpatialParser**, **PDFSpatialParser**, and **DOCXSpatialParser**) extend S2Chunker with format-specific layout extraction, while **ParentChildChunker** implements a two-tier chunking strategy for parent-child retrieval.

### Architecture

```
                     ┌──────────────────────┐
                     │  LangChain           │
                     │  TextSplitter (ABC)  │
                     └──────────┬───────────┘
                                │ extends
                     ┌──────────▼───────────┐
                     │     S2Chunker        │
                     │  spectral clustering │
                     │  affinity matrix     │
                     │  eigengap heuristic  │
                     └──────────┬───────────┘
                    ┌───────────┤────────────┐
                    │ extends   │ extends    │
         ┌──────────▼──┐  ┌────▼──────────┐ │
         │  Markdown    │  │    PDF        │ │
         │  Spatial     │  │  Spatial      │ │
         │  Parser      │  │  Parser       │ │
         └─────────────┘  └───────────────┘ │
                                            │
                     ┌──────────────────────┐│
                     │  ParentChildChunker  ││
                     │  (independent)       ││
                     └──────────────────────┘│
```

All five modules are registered in the `ModuleRegistry` and can be used as standalone pipeline stages or composed into sub-workflows.

---

## S2Chunker

**Module name**: `S2Chunker` · **File**: `src/modules/chunking/S2Chunker.ts` · **Paper**: arXiv:2501.05485v1 §3

The foundation of MemFlow's chunking system. Extends LangChain's real `TextSplitter` abstract base class from `@langchain/textsplitters`, making it a genuine drop-in replacement for `RecursiveCharacterTextSplitter` or any other LangChain text splitter.

### Algorithm

1. **Prepare elements**: Extract centroid coordinates from `metadata.centroid` or `metadata.bbox` (center of bounding box). Embed text via the provided `embedder` function (or reuse `metadata.embedding`). L2-normalize all embeddings.
2. **Normalize coordinates**: All centroids are normalized to `[0,1]×[0,1]` across the full document set.
3. **Build affinity matrix**: For each pair `(i,j)`:
   ```
   W(i,j) = α · cosineSim(emb_i, emb_j) + (1-α) · spatialSim(centroid_i, centroid_j)
   ```
   where `spatialSim(p1,p2) = 1 / (1 + euclideanDistance(p1, p2))`.
4. **Spectral clustering**: Compute the normalized Laplacian, solve for eigenvalues via Jacobi eigensolver, select `k` via eigengap heuristic (or fallback to `ceil(totalTokens / chunkSize)`), project onto the first `k` eigenvectors, run K-Means++ clustering.
5. **Enforce token limits**: Recursively split oversized clusters via sub-clustering.
6. **Reading order sort**: Final chunks are sorted top→bottom, left→right for natural reading flow.

### Config Schema

| Parameter | Type | Default | Description |
|---|---|---|---|
| `alpha` | `number` (0–1) | `0.5` | Balance between semantic (1.0) and spatial (0.0) similarity |
| `chunkSize` | `number` | `500` | Maximum tokens per chunk |
| `chunkOverlap` | `number` | `0` | Token overlap between adjacent chunks |
| `useEigengap` | `boolean` | `true` | Use eigengap heuristic for automatic k selection |
| `embedder` | `(texts: string[]) => Promise<number[][]>` | — | Batch embedding function (required unless documents carry `metadata.embedding`) |

### Input / Output

| Direction | Fields |
|---|---|
| **Input** | `Document[]` with `metadata.centroid: {x, y}` or `metadata.bbox: {x, y, w, h}` |
| **Output** | `Document[]` with `metadata.chunk_size`, `metadata.element_count`, `metadata.element_ids`, `metadata.centroid` |

### Convenience Subclasses

- **`SemanticChunker`**: `alpha = 1.0` — purely semantic clustering, ignores spatial layout entirely.
- **`SpatialChunker`**: `alpha = 0.0` — groups by physical proximity only.

---

## MarkdownSpatialParser

**Module name**: `MarkdownSpatialParser` · **File**: `src/modules/chunking/MarkdownSpatialParser.ts` · **Paper**: arXiv:2501.05485v1 + Markdown extension

S2Chunker subclass that parses raw Markdown into spatially-tagged atomic blocks, then delegates to the inherited spectral-clustering pipeline.

### Spatial Coordinate Model

The parser assigns a 2D coordinate to each Markdown block:

- **x-axis** → structural depth (hierarchy):
  - `H1 = 0`, `H2 = 1`, `H3 = 2`, …
  - List items: `headingDepth + indentLevel + 1`
  - Code blocks: `headingDepth + 0.5`
  - Blockquotes: `headingDepth + 1`
- **y-axis** → sequential reading order (block index, 0-based)

Both axes are scaled by `xScale` / `yScale` before storage. S2Chunker then re-normalizes to `[0,1]×[0,1]`.

### Block Types

`heading_1`–`heading_6`, `paragraph`, `list_item`, `code_block`, `blockquote`, `thematic_break`, `front_matter`

### Config Schema

Extends S2ChunkerParams:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `xScale` | `number` | `2.0` | Multiplier for x-axis (structural depth sensitivity) |
| `yScale` | `number` | `1.0` | Multiplier for y-axis (sequential position) |

### Input / Output

| Direction | Fields |
|---|---|
| **Input** | Raw Markdown `string` (via `splitText()`) or `Document[]` (via `transformDocuments()`) |
| **Output (atomic)** | `Document[]` with `metadata.centroid`, `metadata.blockType`, `metadata.headingPath`, `metadata.headingDepth` |
| **Output (chunked)** | `Document[]` with S2 chunk metadata (via inherited pipeline) |

### Public API

```typescript
const parser = new MarkdownSpatialParser({ chunkSize: 150, alpha: 0.5, embedder });

// Split raw Markdown string
const chunks = await parser.splitText(rawMarkdown);

// Inspect atomic blocks before clustering
const blocks = parser.parseToDocuments(rawMarkdown, { source: "readme.md" });

// Transform pre-loaded LangChain Documents
const chunks = await parser.transformDocuments(markdownDocs);
```

---

## PDFSpatialParser

**Module name**: `PDFSpatialParser` · **File**: `src/modules/chunking/PDFSpatialParser.ts` · **Paper**: arXiv:2501.05485v1 + PDF extension · **Dependency**: `unpdf`

S2Chunker subclass that extracts text with precise bounding boxes from PDF documents using [unpdf](https://github.com/unjs/unpdf) (serverless PDF.js build). Produces atomic `Document[]` with `metadata.bbox`, then delegates to the inherited S2 spectral-clustering pipeline.

### How It Works

1. **Extract text items**: Uses `unpdf.extractTextItems()` which returns per-page arrays of `StructuredTextItem` objects, each with `{ str, x, y, width, height, fontSize, fontFamily, dir, hasEOL }`.
2. **Filter whitespace**: Optionally removes pure-whitespace text items (configurable via `filterWhitespace`).
3. **Line grouping**: Adjacent text items within `lineGroupThreshold` Y-tolerance (default: 2pt) are merged into logical line blocks. This is critical for performance — reduces n from ~2000 per-word items to ~300 line-level blocks on a typical 10-page PDF, keeping the O(n³) Jacobi eigensolver tractable.
4. **Global Y-ordering**: Pages are stacked vertically with a configurable `pageGap` (default: 50pt) to keep them spatially separated after normalization. PDF's bottom-left origin is inverted to top-left for natural reading order.
5. **Produce Documents**: Each line block becomes a `Document` with `metadata.bbox: { x, y, w, h }`, `metadata.page`, `metadata.fontSize`, `metadata.fontFamily`.
6. **Spectral clustering**: Inherited from S2Chunker — the `metadata.bbox` centroids are automatically picked up by `_prepareElements()` at line 364 of `S2Chunker.ts`.

### Config Schema

Extends S2ChunkerParams:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `lineGroupThreshold` | `number` | `2` | Y-tolerance (PDF points) for merging adjacent text items into lines |
| `pageGap` | `number` | `50` | Vertical gap (PDF points) between pages for spatial separation |
| `filterWhitespace` | `boolean` | `true` | Filter out pure-whitespace text items before grouping |

### Input / Output

| Direction | Fields |
|---|---|
| **Input** | `Uint8Array` or `ArrayBuffer` of PDF binary data |
| **Output (atomic)** | `Document[]` with `metadata.bbox: { x, y, w, h }`, `metadata.page`, `metadata.fontSize`, `metadata.fontFamily` |
| **Output (chunked)** | `string[]` (via `splitPDF()`) or `Document[]` (via inherited `transformDocuments()`) |

### Public API

```typescript
const parser = new PDFSpatialParser({
  chunkSize: 450,
  alpha: 0.55,
  embedder: async (texts) => embedder.embedDocuments(texts),
  useEigengap: true,
  lineGroupThreshold: 2,
  filterWhitespace: true,
});

// From a file (Bun example)
const pdfBytes = await Bun.file("report.pdf").arrayBuffer();
const chunks = await parser.splitPDF(new Uint8Array(pdfBytes));

// Or inspect the spatial blocks first
const atomics = await parser.parseToDocuments(new Uint8Array(pdfBytes));
console.log(atomics[0].metadata.bbox);  // { x, y, w, h }
console.log(atomics[0].metadata.page);  // 1
```

### Module Adapter (PDFSpatialParserModule)

The workflow adapter accepts PDF data as either a `Uint8Array` or a base64-encoded string (for HTTP API use). It exposes all parser config options via a Zod schema:

```json
{
  "id": "parse-pdf",
  "module": "PDFSpatialParser",
  "config": {
    "chunkSize": 512,
    "alpha": 0.55,
    "lineGroupThreshold": 2,
    "pageGap": 50,
    "filterWhitespace": true
  },
  "next": "chunk"
}
```

| Input Field | Type | Description |
|---|---|---|
| `data.pdfData` | `Uint8Array \| string (base64)` | PDF binary data |

| Output Field | Type | Description |
|---|---|---|
| `data.documents` | `Document[]` | Spatially-tagged atomic blocks with bbox metadata |
| `metrics.elements` | `number` | Number of atomic elements extracted |
| `metrics.pages` | `number` | Number of PDF pages processed |

### Why This Produces Correct Chunking

- **Spatial bboxes** → centroids + `spatialSim()` (Euclidean on normalized [0,1]×[0,1]) capture columns, reading order, proximity to headings/figures, multi-column layouts.
- **Hybrid graph + spectral clustering** (exactly as in the paper) groups elements that are *both* semantically similar **and** spatially coherent.
- Token-limit enforcement recursively splits oversized clusters while preserving layout.
- Final chunks are reconstructed in natural reading order (Y→X sort).
- Result: far better than `RecursiveCharacterTextSplitter` or naive paragraph splitters on real-world PDFs (reports, papers, invoices, multi-column articles).

---

## ParentChildChunker

**Module name**: `ParentChildChunker` · **File**: `src/modules/chunking/ParentChildChunkerModule.ts` · **Paper**: PriHA

Two-tier chunking strategy: small children for precision retrieval, large parents for LLM context. Persists `:ParentChunk` and `:ChildChunk` nodes with `:BELONGS_TO` edges in Memgraph. Uses `batchQuery()` for N→2 batch persistence.

### Config Schema

| Parameter | Type | Default | Description |
|---|---|---|---|
| `parentChunkSize` | `number` | `2000` | Token size for parent chunks |
| `childChunkSize` | `number` | `400` | Token size for child chunks |
| `chunkOverlap` | `number` | `50` | Token overlap between chunks |

### Input / Output

| Direction | Fields |
|---|---|
| **Input** | `data.documents` or `data.markdown` |
| **Output** | `data.chunks` (child chunks with parent references), `metrics.parentCount`, `metrics.childCount` |

---

## DOCXSpatialParser

**Module name**: `DOCXSpatialParser` · **File**: `src/modules/chunking/DOCXSpatialParser.ts` · **Paper**: arXiv:2501.05485v1 + DOCX extension · **Dependency**: `officeparser`

S2Chunker subclass that extracts text and structural layout from DOCX (Open XML) documents using [officeparser](https://github.com/nicktop/officeparser). Produces atomic `Document[]` with spatial coordinates derived from DOCX structural elements, then delegates to the inherited S2 spectral-clustering pipeline.

### Spatial Coordinate Model

The parser assigns a 2D coordinate to each DOCX block based on its structural role:

- **x-axis** → structural depth (heading depth):
  - `Heading 1 = 0`, `Heading 2 = 1`, `Heading 3 = 2`, …
  - List items: `headingDepth + nestLevel + 1`
  - Table cells: `headingDepth + 0.5`
- **y-axis** → sequential reading order (element index, 0-based)

Both axes are scaled by `xScale` / `yScale` before normalization.

### Block Types

`heading_1`–`heading_6`, `paragraph`, `list_item`, `table_cell`, `table_row`

### Config Schema

Extends S2ChunkerParams:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `xScale` | `number` | `2.0` | Multiplier for x-axis (structural depth sensitivity) |
| `yScale` | `number` | `1.0` | Multiplier for y-axis (sequential position) |

### Input / Output

| Direction | Fields |
|---|---|
| **Input** | `Buffer`, `Uint8Array`, `ArrayBuffer`, or base64 `string` of DOCX binary data |
| **Output (atomic)** | `Document[]` with `metadata.centroid`, `metadata.blockType`, `metadata.headingDepth` |
| **Output (chunked)** | `Document[]` with S2 chunk metadata (via inherited pipeline) |

### Module Adapter (DOCXSpatialParserModule)

The workflow adapter accepts DOCX data as `Buffer`, `Uint8Array`, `ArrayBuffer`, or base64 string:

```json
{
  "id": "parse-docx",
  "module": "DOCXSpatialParser",
  "config": {
    "chunkSize": 512,
    "alpha": 0.5,
    "xScale": 2.0,
    "yScale": 1.0
  },
  "next": "chunk"
}
```

| Input Field | Type | Description |
|---|---|---|
| `data.docxData` | `Buffer \| Uint8Array \| ArrayBuffer \| string (base64)` | DOCX binary data |

| Output Field | Type | Description |
|---|---|---|
| `data.documents` | `Document[]` | Spatially-tagged atomic blocks |
| `metrics.elements` | `number` | Number of atomic elements extracted |
| `metrics.blocks_*` | `number` | Per-block-type counts |

---

## Choosing the Right Chunking Strategy

| Scenario | Recommended Module | Why |
|---|---|---|
| Plain text or Markdown documents | `MarkdownSpatialParser` | Structure-aware spatial coordinates from heading hierarchy |
| PDF documents (reports, papers, invoices) | `PDFSpatialParser` | Precise bounding boxes from PDF text layer |
| DOCX documents (Word files) | `DOCXSpatialParser` | Structural layout extraction from Open XML |
| Parent-child retrieval (PriHA) | `ParentChildChunker` | Two-tier precision/context chunks with graph edges |
| Pre-parsed Documents with custom coordinates | `S2Chunker` directly | Base class — accepts any `centroid` or `bbox` metadata |
| Pure semantic chunking (no layout) | `SemanticChunker` | S2Chunker with `alpha=1.0` |
| Pure spatial grouping (no semantics) | `SpatialChunker` | S2Chunker with `alpha=0.0` |

## Performance Considerations

- **Jacobi eigensolver**: O(n³) where n = number of atomic elements. For most documents (< 500 elements after line grouping) this completes in < 1s.
- **PDF line grouping**: Reduces n by ~10× on typical PDFs. Without grouping, a 10-page paper produces ~2000 per-word items; with grouping, ~200–300 logical lines.
- **Embedding calls**: S2 requires one batch embedding call for all atomic elements. Batch your embedder for throughput.
- **Large PDFs**: For documents > 1000 pages, consider splitting into page ranges and processing separately, then merging results.
