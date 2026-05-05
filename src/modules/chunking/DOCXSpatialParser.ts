/**
 * DOCXSpatialParser
 *
 * DOCX-aware S2Chunker subclass. Uses officeparser for typed AST extraction,
 * then builds spatially-tagged atomic Documents (heading depth + reading order)
 * exactly like MarkdownSpatialParser.
 *
 * Architecture:
 *
 *   DOCX binary (Uint8Array / ArrayBuffer / Buffer)
 *        │
 *        ▼  splitDOCX() / parseToDocuments()
 *   officeparser.parseOffice()  →  OfficeParserAST
 *        │
 *        ▼  _astToDocuments()  ← walk content nodes
 *   Document[]  with metadata.centroid, blockType, headingPath, headingDepth
 *        │
 *        ▼  super.transformDocuments()  ← inherited S2 spectral clustering
 *   Document[]  (S2 chunks, reading-order sorted, token-bounded)
 *
 * Spatial coordinate model (same as MarkdownSpatialParser):
 *
 *   x-axis  →  structural depth (hierarchy)
 *              H1=0, H2=1, H3=2 …
 *              list items add +1 per indent level on top of current heading depth
 *              tables sit at heading depth + 0.5
 *
 *   y-axis  →  sequential reading order (block index, 0-based)
 *
 *   Both axes are scaled by xScale / yScale before being stored in
 *   metadata.centroid. S2Chunker._prepareElements() then re-normalises
 *   all centroids to [0,1]×[0,1] across the full document set before
 *   building the affinity matrix.
 *
 * Usage:
 *
 *   const parser = new DOCXSpatialParser({ chunkSize: 500, alpha: 0.5, embedder });
 *   const chunks = await parser.splitDOCX(docxBytes);   // → string[]
 *
 *   // Inspect atomic blocks before S2 clustering:
 *   const blocks = await parser.parseToDocuments(docxBytes);
 *   console.log(blocks[0].metadata); // { blockType, headingDepth, centroid, … }
 */

import { Document } from "@langchain/core/documents";
import { S2Chunker, type S2ChunkerParams } from "./S2Chunker.js";
import { unzipSync } from "fflate";
// Types only — erased at compile time, no runtime module load.
import type { OfficeContentNode, HeadingMetadata, ListMetadata } from "officeparser";

// ---------------------------------------------------------------------------
// Bun compatibility shim
//
// officeparser internally calls fflate.unzip() — the async, worker-based
// variant — which silently fails on Bun due to incompatible Worker support.
//
// This block patches the CJS module cache BEFORE require("officeparser")
// resolves fflate, replacing the async unzip() with a synchronous shim
// that wraps unzipSync() and delivers the result via queueMicrotask().
//
// We must use require("fflate") here (not the ESM import above) because
// officeparser also uses require("fflate"), and we need to mutate the
// exact same CJS exports object it will receive. ESM namespace objects
// are read-only and cannot be patched.
// ---------------------------------------------------------------------------
if (typeof globalThis.Bun !== "undefined") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fflateExports = require("fflate");
    if (typeof fflateExports.unzip === "function") {
      fflateExports.unzip = (
        data: Uint8Array,
        optsOrCb: any,
        cb?: any,
      ) => {
        const opts = typeof optsOrCb === "function" ? undefined : optsOrCb;
        const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
        try {
          const all = unzipSync(data);
          let result: Record<string, Uint8Array> = all;
          if (opts?.filter) {
            result = {};
            for (const [name, content] of Object.entries(all) as [string, Uint8Array][]) {
              if (opts.filter({ name, size: content.length, originalSize: content.length })) {
                result[name] = content;
              }
            }
          }
          queueMicrotask(() => callback(null, result));
        } catch (e) {
          queueMicrotask(() => callback(e as Error));
        }
      };
    }
  } catch { /* fflate not available — officeparser will fail on its own */ }
}

// Deferred require: runs AFTER the patch above (unlike ESM imports which hoist).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseOffice } = require("officeparser") as typeof import("officeparser");

// ---------------------------------------------------------------------------
// Block type taxonomy (mirrors MarkdownSpatialParser's BlockType)
// ---------------------------------------------------------------------------

export type DocxBlockType =
  | "heading_1" | "heading_2" | "heading_3"
  | "heading_4" | "heading_5" | "heading_6"
  | "paragraph"
  | "list_item"
  | "table"
  | "image"
  | "note"
  | "other";

// ---------------------------------------------------------------------------
// Parser-specific options — extend S2ChunkerParams
// ---------------------------------------------------------------------------

export interface DOCXSpatialParserParams extends S2ChunkerParams {
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

export interface DocxBlockMetadata {
  blockType: DocxBlockType;
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
// DOCXSpatialParser
// ---------------------------------------------------------------------------

export class DOCXSpatialParser extends S2Chunker {
  private readonly xScale: number;
  private readonly yScale: number;

  constructor(fields: Partial<DOCXSpatialParserParams> = {}) {
    super(fields);
    this.xScale = fields.xScale ?? 2.0;
    this.yScale = fields.yScale ?? 1.0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse a DOCX binary into spatially-tagged atomic Documents.
   *
   * Each document = one logical block (paragraph, heading, list item, table)
   * with centroid and structural metadata, ready for S2 spectral clustering.
   *
   * Accepts Uint8Array, ArrayBuffer, or Node Buffer.
   */
  async parseToDocuments(
    docxData: Uint8Array | ArrayBuffer | Buffer,
    baseMetadata: Record<string, unknown> = {},
  ): Promise<Document[]> {
    const buffer = DOCXSpatialParser._toBuffer(docxData);

    // Pre-extract heading style map from styles.xml for Google Docs compat.
    // officeparser only recognises heading styles whose ID starts with
    // "Heading" (e.g. "Heading1"), but Google Docs/Libre export numeric IDs
    // (e.g. "749" for "Heading 1"). We build the map ourselves so that
    // _astToDocuments can reclassify paragraph nodes as headings.
    const headingStyleMap = DOCXSpatialParser._extractHeadingStyleMap(buffer);

    const ast = await parseOffice(buffer);
    return this._astToDocuments(ast.content, baseMetadata, headingStyleMap);
  }

  /**
   * Split a DOCX binary directly into final S2 chunks (strings).
   *
   * This is the primary convenience entry point:
   *  1. Parses DOCX into spatially-tagged atomic blocks
   *  2. Delegates to the inherited S2 spectral-clustering pipeline
   *  3. Returns the resulting chunk strings
   */
  async splitDOCX(docxData: Uint8Array | ArrayBuffer | Buffer): Promise<string[]> {
    const atomic = await this.parseToDocuments(docxData);
    if (atomic.length === 0) return [];
    const chunks = await super.transformDocuments(atomic);
    return chunks.map(d => d.pageContent);
  }

  /**
   * Transform pre-loaded Documents whose `metadata.docxData` contains
   * DOCX binary data. Each input document is parsed independently;
   * its existing metadata is preserved as base metadata on every block.
   * Blocks from all inputs are co-clustered by S2 in a single pass.
   */
  override async transformDocuments(documents: Document[]): Promise<Document[]> {
    if (documents.length === 0) return [];

    const atomic: Document[] = [];
    for (const doc of documents) {
      const rawData = doc.metadata.docxData;
      if (rawData instanceof Uint8Array || rawData instanceof ArrayBuffer || Buffer.isBuffer(rawData)) {
        const blocks = await this.parseToDocuments(rawData, doc.metadata);
        atomic.push(...blocks);
      } else if (typeof doc.pageContent === "string" && doc.pageContent.length > 0) {
        // Fall back to treating it as a plain-text document
        atomic.push(doc);
      }
    }

    if (atomic.length === 0) return [];
    return super.transformDocuments(atomic);
  }

  /** splitText is not suitable for binary DOCX — use splitDOCX instead. */
  override async splitText(_text: string): Promise<string[]> {
    throw new Error(
      "DOCXSpatialParser: use splitDOCX(docxBytes) or parseToDocuments(docxBytes) instead of splitText(). " +
        "DOCX parsing requires binary input, not a text string.",
    );
  }

  // -------------------------------------------------------------------------
  // Private: AST → atomic Document[]
  // -------------------------------------------------------------------------

  private _astToDocuments(
    nodes: OfficeContentNode[],
    baseMetadata: Record<string, unknown>,
    headingStyleMap: Map<string, number> = new Map(),
  ): Document[] {
    const docs: Document[] = [];
    let y = 0;
    let currentDepth = 0;
    const headingStack: { level: number; text: string }[] = [];

    for (const node of nodes) {
      let blockType: DocxBlockType = "paragraph";
      let text = "";
      let x = currentDepth;

      switch (node.type) {
        // ── Headings ──────────────────────────────────────────────────────
        case "heading": {
          const meta = node.metadata as HeadingMetadata | undefined;
          const level = meta?.level ?? 1;
          blockType = `heading_${Math.min(level, 6)}` as DocxBlockType;
          currentDepth = level - 1;
          x = currentDepth;
          text = node.text ?? "";

          // Maintain heading ancestry stack (same logic as MarkdownSpatialParser)
          while (
            headingStack.length > 0 &&
            headingStack[headingStack.length - 1].level >= level
          ) {
            headingStack.pop();
          }
          headingStack.push({ level, text });
          break;
        }

        // ── Lists ─────────────────────────────────────────────────────────
        case "list": {
          blockType = "list_item";
          const meta = node.metadata as ListMetadata | undefined;
          const indent = meta?.indentation ?? 0;
          x = currentDepth + indent + 1;
          text = node.text ?? "";
          break;
        }

        // ── Tables ────────────────────────────────────────────────────────
        case "table": {
          blockType = "table";
          x = currentDepth + 0.5;
          text = this._tableToMarkdown(node);
          break;
        }

        // ── Images ────────────────────────────────────────────────────────
        case "image": {
          blockType = "image";
          text = node.text ?? "[Image]";
          x = currentDepth;
          break;
        }

        // ── Notes (footnotes/endnotes) ────────────────────────────────────
        case "note": {
          blockType = "note";
          text = node.text ?? "";
          x = currentDepth + 0.5;
          break;
        }

        // ── Paragraphs / fallback ─────────────────────────────────────────
        case "paragraph":
        default: {
          text = node.text ?? "";

          // Google Docs / Libre DOCX compat: reclassify paragraph as heading
          // if its style matches a known heading style ID from styles.xml.
          const styleId = (node.metadata as Record<string, unknown> | undefined)?.style as string | undefined;
          const headingLevel = styleId ? headingStyleMap.get(styleId) : undefined;

          if (headingLevel !== undefined) {
            // Treat as heading (same logic as the "heading" case above)
            blockType = `heading_${Math.min(headingLevel, 6)}` as DocxBlockType;
            currentDepth = headingLevel - 1;
            x = currentDepth;
            while (
              headingStack.length > 0 &&
              headingStack[headingStack.length - 1].level >= headingLevel
            ) {
              headingStack.pop();
            }
            headingStack.push({ level: headingLevel, text });
          } else {
            blockType = node.type === "paragraph" ? "paragraph" : "other";
            x = currentDepth;
          }
          break;
        }
      }

      // Skip empty blocks (but keep headings for structure)
      if (!text.trim() && !blockType.startsWith("heading")) continue;

      const headingPath = headingStack.map(h => h.text);
      const headingDepth = headingStack.length > 0
        ? headingStack[headingStack.length - 1].level - 1
        : 0;

      const meta: DocxBlockMetadata = {
        ...baseMetadata,
        blockType,
        headingPath,
        headingDepth,
        centroid: {
          x: x * this.xScale,
          y: y * this.yScale,
        },
      };

      docs.push(new Document({ pageContent: text, metadata: meta }));
      y += 1;
    }

    return docs;
  }

  // -------------------------------------------------------------------------
  // Private: Table → Markdown string
  // -------------------------------------------------------------------------

  /**
   * Convert a table AST node to a Markdown table string.
   * Tables are treated as single atomic blocks so S2 keeps them coherent.
   */
  private _tableToMarkdown(tableNode: OfficeContentNode): string {
    if (!tableNode.children || tableNode.children.length === 0) return "[Table]";

    const rows = tableNode.children.filter(c => c.type === "row");
    if (rows.length === 0) return "[Table]";

    const lines: string[] = [];

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const cells = row.children?.filter(c => c.type === "cell") ?? [];
      const cellTexts = cells.map(c => (c.text ?? "").replace(/\|/g, "\\|").trim());
      lines.push("| " + cellTexts.join(" | ") + " |");

      // Add separator after header row
      if (ri === 0) {
        lines.push("| " + cellTexts.map(() => "---").join(" | ") + " |");
      }
    }

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Private: Heading-style map extraction (Google Docs / Libre compat)
  // -------------------------------------------------------------------------

  /**
   * Extract a map of `styleId → headingLevel` from `word/styles.xml` inside
   * the DOCX ZIP. This handles editors like Google Docs and LibreOffice that
   * assign numeric IDs (e.g. "749") instead of semantic IDs (e.g. "Heading1").
   *
   * Uses `fflate.unzipSync` (sync) to avoid the async worker issue on Bun.
   * If the styles.xml cannot be read, returns an empty map (graceful fallback).
   */
  private static _extractHeadingStyleMap(buffer: Buffer): Map<string, number> {
    const map = new Map<string, number>();
    try {
      const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const files = unzipSync(u8);

      // Find styles.xml (may be word/styles.xml or word/styles1.xml)
      const stylesKey = Object.keys(files).find(k => /^word\/styles\d*\.xml$/i.test(k));
      if (!stylesKey) return map;

      const stylesXml = Buffer.from(files[stylesKey]).toString("utf8");

      // Match <w:style w:type="paragraph" w:styleId="NNN"> ... <w:name w:val="heading N"/> ...
      // Uses a simple regex approach — XML is well-formed OOXML so this is reliable.
      const styleRegex = /<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g;
      let match: RegExpExecArray | null;
      while ((match = styleRegex.exec(stylesXml)) !== null) {
        const block = match[0];
        const styleId = match[1];

        // Check if this style has a heading name
        const nameMatch = block.match(/<w:name\s+w:val="[Hh]eading\s+(\d+)"/i);
        if (nameMatch) {
          const level = parseInt(nameMatch[1], 10);
          if (level >= 1 && level <= 9) {
            // Only add if the styleId doesn't already start with "Heading"
            // (officeparser handles those natively)
            if (!styleId.startsWith("Heading")) {
              map.set(styleId, level);
            }
          }
        }
      }
    } catch {
      // Graceful fallback — heading detection reverts to officeparser's native logic
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Private: Buffer normalisation
  // -------------------------------------------------------------------------

  /**
   * Ensure input is a Node Buffer (required by officeparser).
   * Handles Uint8Array, ArrayBuffer, and Buffer inputs.
   */
  private static _toBuffer(data: Uint8Array | ArrayBuffer | Buffer): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    // Uint8Array — extract the underlying segment
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
}
