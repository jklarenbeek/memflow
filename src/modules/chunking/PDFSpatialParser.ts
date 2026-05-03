/**
 * PDFSpatialParser
 *
 * PDF-aware S2Chunker subclass. Extracts text + precise bounding boxes
 * using unpdf's extractTextItems(), produces atomic Documents with
 * metadata.bbox, then delegates to the full S2 spectral-clustering pipeline.
 *
 * Supports multi-page documents with global Y-order (pages stacked vertically
 * so cross-page clusters are naturally discouraged unless strongly justified).
 *
 * Line-grouping pass: Adjacent text items on the same line (within
 * `lineGroupThreshold` Y-tolerance) are merged into logical blocks.
 * This reduces n for spectral clustering from ~2000 per-word items
 * to ~200 line-level blocks on a typical 10-page PDF.
 *
 * Usage:
 *   const parser = new PDFSpatialParser({ chunkSize: 450, alpha: 0.55, embedder });
 *   const chunks = await parser.splitPDF(pdfBytes);           // Uint8Array
 *   const atomics = await parser.parseToDocuments(pdfBytes);  // inspect bboxes
 */

import { Document } from "@langchain/core/documents";
import { S2Chunker, type S2ChunkerParams } from "./S2Chunker.js";
import { extractTextItems, type StructuredTextItem } from "unpdf";

// ---------------------------------------------------------------------------
// Parser-specific options — extend S2ChunkerParams
// ---------------------------------------------------------------------------

export interface PDFSpatialParserParams extends S2ChunkerParams {
  /**
   * Y-tolerance (in PDF points) for merging adjacent text items into lines.
   * Items whose Y positions differ by less than this are grouped.
   * @default 2
   */
  lineGroupThreshold?: number;
  /**
   * Vertical gap (in PDF points) inserted between pages to keep them
   * spatially separated after normalization.
   * @default 50
   */
  pageGap?: number;
  /**
   * Whether to filter out pure-whitespace text items before grouping.
   * @default true
   */
  filterWhitespace?: boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LineBlock {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  page: number;
  fontSize: number;
  fontFamily: string;
}

// ---------------------------------------------------------------------------
// PDFSpatialParser
// ---------------------------------------------------------------------------

export class PDFSpatialParser extends S2Chunker {
  private readonly lineGroupThreshold: number;
  private readonly pageGap: number;
  private readonly filterWhitespace: boolean;

  constructor(fields: Partial<PDFSpatialParserParams> = {}) {
    super(fields);
    this.lineGroupThreshold = fields.lineGroupThreshold ?? 2;
    this.pageGap = fields.pageGap ?? 50;
    this.filterWhitespace = fields.filterWhitespace ?? true;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse a PDF (Uint8Array / ArrayBuffer) into atomic Documents with bboxes.
   *
   * Each document = one logical line (merged from adjacent text items).
   * S2Chunker will cluster them using the inherited spectral pipeline.
   */
  async parseToDocuments(pdfData: Uint8Array | ArrayBuffer): Promise<Document[]> {
    // Always make a defensive copy — PDF.js may transfer/detach the buffer
    // internally, which would cause DataCloneError on subsequent calls
    // with the same Uint8Array.
    const data = new Uint8Array(
      pdfData instanceof ArrayBuffer ? pdfData : pdfData.buffer.slice(
        pdfData.byteOffset,
        pdfData.byteOffset + pdfData.byteLength,
      ),
    );
    const { totalPages, items } = await extractTextItems(data);

    const docs: Document[] = [];
    let globalYOffset = 0;

    for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
      const pageItems = items[pageIdx];
      if (!pageItems || pageItems.length === 0) {
        globalYOffset += this.pageGap;
        continue;
      }

      // Filter whitespace items if configured
      const filtered = this.filterWhitespace
        ? pageItems.filter((item) => item.str.trim().length > 0)
        : pageItems.filter((item) => item.str != null);

      if (filtered.length === 0) {
        globalYOffset += this.pageGap;
        continue;
      }

      // Determine page height from the items (max y + height)
      const pageHeight = Math.max(
        ...filtered.map((item) => item.y + item.height),
      );

      // Group items into lines, then convert to Documents
      const lines = this._groupIntoLines(filtered);

      for (const line of lines) {
        // PDF origin is bottom-left (y increases UP).
        // Invert to reading order (y increases DOWN) and add global offset.
        const invertedY = pageHeight - (line.bbox.y + line.bbox.h);
        const globalY = globalYOffset + invertedY;

        docs.push(
          new Document({
            pageContent: line.text,
            metadata: {
              bbox: {
                x: line.bbox.x,
                y: globalY,
                w: line.bbox.w,
                h: line.bbox.h,
              },
              page: pageIdx + 1,
              fontSize: line.fontSize,
              fontFamily: line.fontFamily,
            },
          }),
        );
      }

      globalYOffset += pageHeight + this.pageGap;
    }

    return docs;
  }

  /** Convenience: split a PDF directly into final S2 chunks (strings). */
  async splitPDF(pdfData: Uint8Array | ArrayBuffer): Promise<string[]> {
    const atomic = await this.parseToDocuments(pdfData);
    if (atomic.length === 0) return [];
    const chunks = await super.transformDocuments(atomic);
    return chunks.map((d) => d.pageContent);
  }

  /** splitText is not suitable for binary PDFs — use splitPDF instead. */
  override async splitText(_text: string): Promise<string[]> {
    throw new Error(
      "PDFSpatialParser: use splitPDF(pdfBytes) or parseToDocuments(pdfBytes) instead of splitText(). " +
        "PDF parsing requires binary input, not a text string.",
    );
  }

  // -------------------------------------------------------------------------
  // Private: Line grouping
  // -------------------------------------------------------------------------

  /**
   * Group text items into logical lines.
   *
   * Items are sorted by Y (descending, since PDF y increases upward)
   * then by X (left to right). Adjacent items within `lineGroupThreshold`
   * Y-tolerance are merged into a single line with a union bounding box.
   */
  private _groupIntoLines(items: StructuredTextItem[]): LineBlock[] {
    if (items.length === 0) return [];

    // Sort: primary by Y descending (top of page first in PDF coords),
    // secondary by X ascending (left to right)
    const sorted = [...items].sort((a, b) => {
      const dy = b.y - a.y;
      return Math.abs(dy) > this.lineGroupThreshold ? dy : a.x - b.x;
    });

    const lines: LineBlock[] = [];
    let currentLine: StructuredTextItem[] = [sorted[0]];
    let currentY = sorted[0].y;

    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i];

      if (Math.abs(item.y - currentY) <= this.lineGroupThreshold) {
        // Same line — accumulate
        currentLine.push(item);
      } else {
        // New line — flush current
        lines.push(this._mergeLine(currentLine));
        currentLine = [item];
        currentY = item.y;
      }
    }

    // Flush final line
    if (currentLine.length > 0) {
      lines.push(this._mergeLine(currentLine));
    }

    return lines;
  }

  /**
   * Merge a set of text items (known to be on the same line) into a single
   * LineBlock. Items are sorted left-to-right before concatenation.
   * The bounding box is the union of all item bboxes.
   */
  private _mergeLine(items: StructuredTextItem[]): LineBlock {
    // Sort left to right within the line
    const sorted = [...items].sort((a, b) => a.x - b.x);

    const text = sorted.map((item) => item.str).join(" ");

    // Union bounding box
    const minX = Math.min(...sorted.map((i) => i.x));
    const minY = Math.min(...sorted.map((i) => i.y));
    const maxX = Math.max(...sorted.map((i) => i.x + i.width));
    const maxY = Math.max(...sorted.map((i) => i.y + i.height));

    // Use the most common font in the line (or the first item's font)
    const fontSize = sorted[0].fontSize;
    const fontFamily = sorted[0].fontFamily;

    return {
      text,
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      page: 0, // Set by caller
      fontSize,
      fontFamily,
    };
  }
}
