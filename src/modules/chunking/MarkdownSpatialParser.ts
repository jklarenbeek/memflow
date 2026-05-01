/**
 * MarkdownSpatialParser
 *
 * A Markdown-aware S2Chunker subclass. It overrides `splitText()` to parse
 * raw Markdown into spatially-tagged atomic blocks, then delegates the full
 * S2 spectral-clustering pipeline (inherited from S2Chunker) to produce
 * coherent, token-bounded chunks in one call.
 *
 * Architecture:
 *
 *   raw Markdown string
 *        │
 *        ▼  splitText() / transformDocuments(raw)
 *   _parseToDocuments()   ← Markdown → atomic Document[]
 *        │                  each with metadata.centroid, blockType,
 *        │                  headingPath, headingDepth
 *        ▼
 *   super.transformDocuments()  ← inherited S2 spectral clustering
 *        │
 *        ▼
 *   Document[]  (S2 chunks, reading-order sorted, token-bounded)
 *
 * Usage — identical to any LangChain TextSplitter:
 *
 *   const splitter = new MarkdownSpatialParser({
 *     chunkSize: 150,
 *     alpha: 0.5,
 *     embedder: async (texts) => embedder.embedDocuments(texts),
 *   });
 *
 *   // From a raw Markdown string:
 *   const chunks = await splitter.splitText(rawMarkdown);
 *
 *   // From pre-loaded LangChain Documents (e.g. from a Markdown document loader):
 *   const chunks = await splitter.transformDocuments(markdownDocs);
 *
 *   // Inspect atomic blocks before chunking:
 *   const blocks = splitter.parseToDocuments(rawMarkdown, { source: "readme.md" });
 *
 * Spatial coordinate model:
 *
 *   x-axis  →  structural depth (hierarchy)
 *              H1=0, H2=1, H3=2 …
 *              list items add +1 per indent level on top of current heading depth
 *              code blocks sit at heading depth + 0.5 (related to context, not a new section)
 *              blockquotes sit at heading depth + 1
 *
 *   y-axis  →  sequential reading order (block index, 0-based)
 *
 *   Both axes are scaled by xScale / yScale before being stored in
 *   metadata.centroid. S2Chunker._prepareElements() then re-normalises
 *   all centroids to [0,1]×[0,1] across the full document set before
 *   building the affinity matrix.
 */

import { Document } from "@langchain/core/documents";
import { S2Chunker, type S2ChunkerParams } from "./S2Chunker";

// ---------------------------------------------------------------------------
// Block type taxonomy
// ---------------------------------------------------------------------------

export type BlockType =
  | "heading_1" | "heading_2" | "heading_3"
  | "heading_4" | "heading_5" | "heading_6"
  | "paragraph"
  | "list_item"
  | "code_block"
  | "blockquote"
  | "thematic_break"
  | "front_matter";

// ---------------------------------------------------------------------------
// Parser-specific options — extend S2ChunkerParams so everything is one config
// ---------------------------------------------------------------------------

export interface MarkdownSpatialParserParams extends S2ChunkerParams {
  /**
   * Multiplier for the x-axis (structural depth).
   * Higher values make S2 more sensitive to hierarchy changes.
   * @default 2.0
   */
  xScale?: number;
  /**
   * Multiplier for the y-axis (sequential reading position).
   * @default 1.0
   */
  yScale?: number;
}

// ---------------------------------------------------------------------------
// Metadata shape on every atomic block Document
// ---------------------------------------------------------------------------

export interface MarkdownBlockMetadata {
  blockType: BlockType;
  /**
   * Raw (pre-normalisation) centroid produced by the parser.
   * S2Chunker will re-normalise this to [0,1]×[0,1] across the full set.
   */
  centroid: { x: number; y: number };
  /**
   * Full ancestor heading path, e.g. ["System Architecture", "Database Design"].
   * Ideal for breadcrumb-style chunk headers in RAG prompts.
   */
  headingPath: string[];
  /** 0-based depth of the nearest ancestor heading (H1 ancestor → 0). */
  headingDepth: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MarkdownSpatialParser
// ---------------------------------------------------------------------------

export class MarkdownSpatialParser extends S2Chunker {
  private readonly xScale: number;
  private readonly yScale: number;

  constructor(fields: Partial<MarkdownSpatialParserParams> = {}) {
    super(fields);
    this.xScale = fields.xScale ?? 2.0;
    this.yScale = fields.yScale ?? 1.0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Split a raw Markdown string into S2 chunks.
   *
   * This is the primary entry point for plain strings. It:
   *  1. Parses Markdown into atomic spatially-tagged Documents
   *  2. Delegates to the inherited S2 clustering pipeline
   *  3. Returns the resulting chunk strings
   */
  override async splitText(text: string): Promise<string[]> {
    const atomic = this._parseToDocuments(text);
    const chunks = await super.transformDocuments(atomic);
    return chunks.map(d => d.pageContent);
  }

  /**
   * Transform pre-loaded LangChain Documents whose `pageContent` is Markdown.
   *
   * Each input document is parsed independently; its `metadata` is carried
   * forward as `baseMetadata` on every atomic block. Blocks from all input
   * documents are then co-clustered by S2 in a single pass.
   */
  override async transformDocuments(documents: Document[]): Promise<Document[]> {
    if (documents.length === 0) return [];
    const atomic: Document[] = documents.flatMap(doc =>
      this._parseToDocuments(doc.pageContent, doc.metadata)
    );
    return super.transformDocuments(atomic);
  }

  /**
   * Parse Markdown to atomic Documents **without** running the S2 chunker.
   *
   * Use this to inspect the spatial block structure, debug coordinate
   * assignments, or feed blocks to a different downstream transformer.
   */
  parseToDocuments(
    markdown: string,
    baseMetadata: Record<string, unknown> = {}
  ): Document[] {
    return this._parseToDocuments(markdown, baseMetadata);
  }

  // -------------------------------------------------------------------------
  // Private: Markdown → atomic Document[]
  // -------------------------------------------------------------------------

  private _parseToDocuments(
    markdown: string,
    baseMetadata: Record<string, unknown> = {}
  ): Document[] {
    const blocks = this._splitIntoBlocks(markdown);
    const docs: Document[] = [];

    /**
     * Heading ancestor stack.
     * Each entry: { level: 1–6, text: string }
     * Maintained so every block carries its full heading ancestry.
     */
    const headingStack: { level: number; text: string }[] = [];

    /** Current x-depth driven by the most recent heading. */
    let currentDepth = 0;
    /** Sequential block counter for y-axis. */
    let y = 0;

    for (const block of blocks) {
      const firstLine = block.split('\n')[0];
      let x = currentDepth;
      let blockType: BlockType = "paragraph";

      // ── Headings ────────────────────────────────────────────────────────
      const headingMatch = firstLine.match(/^(#{1,6})\s+(.*)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();
        blockType = `heading_${level}` as BlockType;
        currentDepth = level - 1;   // H1→0, H2→1, H3→2 …
        x = currentDepth;

        // Trim the stack to only keep ancestors strictly shallower than this heading
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text: headingText });
      }
      // ── List items ──────────────────────────────────────────────────────
      else if (/^(\s*)([-*+]|\d+\.)\s/.test(firstLine)) {
        const indentMatch = firstLine.match(/^(\s*)/);
        const spaces = indentMatch ? indentMatch[1].length : 0;
        // Every 2 spaces = one extra list depth level
        const listDepth = Math.floor(spaces / 2) + 1;
        x = currentDepth + listDepth;
        blockType = "list_item";
      }
      // ── Fenced code blocks ──────────────────────────────────────────────
      else if (/^(`{3,}|~{3,})/.test(firstLine.trim())) {
        // Sit slightly deeper than the current heading context but not a new section
        x = currentDepth + 0.5;
        blockType = "code_block";
      }
      // ── Blockquotes ─────────────────────────────────────────────────────
      else if (firstLine.trim().startsWith('>')) {
        x = currentDepth + 1;
        blockType = "blockquote";
      }
      // ── Thematic breaks ─────────────────────────────────────────────────
      else if (/^(---+|\*\*\*+|___+)\s*$/.test(firstLine.trim())) {
        x = 0;
        blockType = "thematic_break";
        // A thematic break is a hard section boundary — reset all context
        headingStack.length = 0;
        currentDepth = 0;
      }
      // ── YAML front matter ───────────────────────────────────────────────
      else if (y === 0 && firstLine.trim() === '---') {
        x = 0;
        blockType = "front_matter";
      }
      // ── Regular paragraph ───────────────────────────────────────────────
      else {
        x = currentDepth;
        blockType = "paragraph";
      }

      const headingPath = headingStack.map(h => h.text);
      // headingDepth: 0-based depth of nearest ancestor (H1=0, H2=1 …)
      const headingDepth = headingStack.length > 0
        ? headingStack[headingStack.length - 1].level - 1
        : 0;

      const meta: MarkdownBlockMetadata = {
        ...baseMetadata,
        blockType,
        headingPath,
        headingDepth,
        centroid: {
          x: x * this.xScale,
          y: y * this.yScale,
        },
      };

      docs.push({ pageContent: block, metadata: meta });
      y += 1;
    }

    return docs;
  }

  // -------------------------------------------------------------------------
  // Private: Markdown block splitter
  // -------------------------------------------------------------------------

  /**
   * Split Markdown into atomic blocks, keeping fenced code blocks intact.
   *
   * Rules:
   *  - Fences (``` or ~~~, 3+ chars) accumulate lines until the matching
   *    closing fence; the entire fence is emitted as one block.
   *  - YAML front matter (`---` … `---` at the very start) is one block.
   *  - Outside fences, blank lines act as block separators.
   *  - Empty blocks are dropped.
   *  - Unclosed fences at EOF are flushed as a single code block.
   */
  private _splitIntoBlocks(markdown: string): string[] {
    const lines = markdown.split('\n');
    const blocks: string[] = [];
    let current: string[] = [];
    let inFence = false;
    let fenceMarker = '';
    let inFrontMatter = false;
    let frontMatterDone = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // ── YAML front matter (must be the very first line) ─────────────────
      if (!frontMatterDone && !inFrontMatter && i === 0 && trimmed === '---') {
        inFrontMatter = true;
        current.push(line);
        continue;
      }
      if (inFrontMatter) {
        current.push(line);
        if (i > 0 && trimmed === '---') {
          blocks.push(current.join('\n'));
          current = [];
          inFrontMatter = false;
          frontMatterDone = true;
        }
        continue;
      }

      // ── Fenced code block ────────────────────────────────────────────────
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (!inFence && fenceMatch) {
        // Flush any pending paragraph before opening the fence
        if (current.length > 0) {
          blocks.push(current.join('\n'));
          current = [];
        }
        inFence = true;
        fenceMarker = fenceMatch[1];
        current.push(line);
        continue;
      }
      if (inFence) {
        current.push(line);
        // A closing fence must start with the same marker and have no info string
        if (i > 0 && trimmed.startsWith(fenceMarker) && /^(`+|~+)\s*$/.test(trimmed)) {
          blocks.push(current.join('\n'));
          current = [];
          inFence = false;
          fenceMarker = '';
        }
        continue;
      }

      // ── Normal block splitting on blank lines ────────────────────────────
      if (trimmed === '') {
        if (current.length > 0) {
          blocks.push(current.join('\n'));
          current = [];
        }
      } else {
        current.push(line);
      }
    }

    // Flush any remaining content (handles unclosed fences gracefully)
    if (current.length > 0) blocks.push(current.join('\n'));

    return blocks.filter(b => b.trim().length > 0);
  }
}