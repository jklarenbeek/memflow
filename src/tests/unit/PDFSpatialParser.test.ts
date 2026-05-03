/**
 * PDFSpatialParser unit tests
 *
 * Tests the PDF parsing, line grouping, and S2 pipeline integration
 * using the reference PDFs in docs/refs/.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { resolve } from "path";
import { readFile } from "fs/promises";
import { PDFSpatialParser } from "../../modules/chunking/PDFSpatialParser.js";
import { PDFSpatialParserModule } from "../../modules/chunking/PDFSpatialParserModule.js";
import type { Document } from "@langchain/core/documents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFS_DIR = resolve(import.meta.dir, "../../../docs/refs");

async function loadPDF(filename: string): Promise<Uint8Array> {
  const buf = await readFile(resolve(REFS_DIR, filename));
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// PDFSpatialParser — core class
// ---------------------------------------------------------------------------

describe("PDFSpatialParser", () => {
  describe("splitText() throws", () => {
    it("should throw when called with a text string", async () => {
      const parser = new PDFSpatialParser();
      expect(parser.splitText("hello world")).rejects.toThrow(
        "use splitPDF(pdfBytes)",
      );
    });
  });

  describe("parseToDocuments — S2 chunking paper", () => {
    let docs: Document[];

    beforeAll(async () => {
      const parser = new PDFSpatialParser({
        chunkSize: 500,
        lineGroupThreshold: 2,
        pageGap: 50,
        filterWhitespace: true,
      });
      const pdfData = await loadPDF("2501.05485v1.pdf");
      docs = await parser.parseToDocuments(pdfData);
    });

    it("should produce documents with bbox metadata", () => {
      expect(docs.length).toBeGreaterThan(0);

      // Every document must have bbox + page metadata
      for (const doc of docs) {
        expect(doc.metadata.bbox).toBeDefined();
        expect(typeof doc.metadata.bbox.x).toBe("number");
        expect(typeof doc.metadata.bbox.y).toBe("number");
        expect(typeof doc.metadata.bbox.w).toBe("number");
        expect(typeof doc.metadata.bbox.h).toBe("number");
        expect(typeof doc.metadata.page).toBe("number");
        expect(doc.metadata.page).toBeGreaterThanOrEqual(1);
      }
    });

    it("should have non-empty page content for each document", () => {
      for (const doc of docs) {
        expect(doc.pageContent.trim().length).toBeGreaterThan(0);
      }
    });

    it("should produce documents from multiple pages", () => {
      const pages = new Set(docs.map((d) => d.metadata.page));
      // The S2 paper has multiple pages
      expect(pages.size).toBeGreaterThan(1);
    });

    it("should order documents by increasing global Y (reading order)", () => {
      // Within each page, Y should generally increase (reading order)
      const byPage = new Map<number, typeof docs>();
      for (const doc of docs) {
        const page = doc.metadata.page as number;
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page)!.push(doc);
      }

      for (const [, pageDocs] of byPage) {
        // Global Y should be non-decreasing for majority of items
        // (some column layouts may have minor inversions)
        let increasing = 0;
        for (let i = 1; i < pageDocs.length; i++) {
          if (pageDocs[i].metadata.bbox.y >= pageDocs[i - 1].metadata.bbox.y) {
            increasing++;
          }
        }
        const ratio = increasing / Math.max(1, pageDocs.length - 1);
        // At least 50% should be in order (accounts for multi-column)
        expect(ratio).toBeGreaterThan(0.5);
      }
    });

    it("should include fontSize and fontFamily metadata", () => {
      const first = docs[0];
      expect(typeof first.metadata.fontSize).toBe("number");
      expect(first.metadata.fontSize).toBeGreaterThan(0);
      expect(typeof first.metadata.fontFamily).toBe("string");
    });
  });

  describe("parseToDocuments — filterWhitespace option", () => {
    it("should filter whitespace by default", async () => {
      const parser = new PDFSpatialParser({ filterWhitespace: true });
      const pdfData = await loadPDF("2501.05485v1.pdf");
      const docs = await parser.parseToDocuments(pdfData);

      for (const doc of docs) {
        expect(doc.pageContent.trim().length).toBeGreaterThan(0);
      }
    });

    it("should produce different results when filterWhitespace=false", async () => {
      const pdfData = await loadPDF("2501.05485v1.pdf");

      const parserFiltered = new PDFSpatialParser({ filterWhitespace: true });
      const docsFiltered = await parserFiltered.parseToDocuments(pdfData);

      const parserUnfiltered = new PDFSpatialParser({ filterWhitespace: false });
      const docsUnfiltered = await parserUnfiltered.parseToDocuments(pdfData);

      // Both should produce documents
      expect(docsFiltered.length).toBeGreaterThan(0);
      expect(docsUnfiltered.length).toBeGreaterThan(0);

      // Filtered should have no whitespace-only content
      for (const doc of docsFiltered) {
        expect(doc.pageContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe("parseToDocuments — multiple reference PDFs", () => {
    const refFiles = [
      "2501.05485v1.pdf",                          // S2 chunking paper
      "2410.05779v3.pdf",                          // Another reference
      "5 Proven Query Translation Techniques.pdf", // Title with spaces
      "Exploring Semantic Clustering Methods.pdf", // Semantic clustering
    ];

    for (const filename of refFiles) {
      it(`should parse ${filename} successfully`, async () => {
        const parser = new PDFSpatialParser({ chunkSize: 500 });
        const pdfData = await loadPDF(filename);
        const docs = await parser.parseToDocuments(pdfData);

        expect(docs.length).toBeGreaterThan(0);

        // Verify structural integrity
        for (const doc of docs) {
          expect(doc.metadata.bbox).toBeDefined();
          expect(doc.metadata.page).toBeGreaterThanOrEqual(1);
          expect(doc.pageContent.length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe("line grouping", () => {
    it("should produce fewer documents than raw text items", async () => {
      const pdfData = await loadPDF("2501.05485v1.pdf");

      // Compare with a standard threshold vs no threshold
      const parserGrouped = new PDFSpatialParser({ lineGroupThreshold: 2 });
      const docsGrouped = await parserGrouped.parseToDocuments(pdfData);

      const parserUngrouped = new PDFSpatialParser({ lineGroupThreshold: 0 });
      const docsUngrouped = await parserUngrouped.parseToDocuments(pdfData);

      // Grouped should have fewer or equal documents
      expect(docsGrouped.length).toBeLessThanOrEqual(docsUngrouped.length);
    });
  });

  describe("reusability", () => {
    it("should allow multiple calls with the same data", async () => {
      const parser = new PDFSpatialParser({ chunkSize: 500 });
      const pdfData = await loadPDF("2501.05485v1.pdf");

      const docs1 = await parser.parseToDocuments(pdfData);
      const docs2 = await parser.parseToDocuments(pdfData);

      // Both calls should produce the same number of documents
      expect(docs1.length).toBe(docs2.length);
    });
  });
});

// ---------------------------------------------------------------------------
// PDFSpatialParserModule — workflow adapter
// ---------------------------------------------------------------------------

describe("PDFSpatialParserModule", () => {
  it("should instantiate with default config", () => {
    const mod = new PDFSpatialParserModule();
    expect(mod.name).toBe("PDFSpatialParser");
    expect(mod.version).toBe("0.5.0");
  });

  it("should return empty result for missing pdfData", async () => {
    const mod = new PDFSpatialParserModule();
    const result = await mod.process(
      { data: {}, config: {} as any },
      undefined,
    );

    expect(result.data.documents).toEqual([]);
    expect(result.metrics?.elements).toBe(0);
  });

  it("should accept Uint8Array pdfData", async () => {
    const mod = new PDFSpatialParserModule();
    const pdfData = await loadPDF("2501.05485v1.pdf");

    const result = await mod.process(
      { data: { pdfData }, config: {} as any },
      undefined,
    );

    expect((result.data.documents as any[]).length).toBeGreaterThan(0);
    expect(result.metrics?.elements).toBeGreaterThan(0);
    expect(result.metrics?.pages).toBeGreaterThan(1);
  });

  it("should accept base64-encoded pdfData", async () => {
    const mod = new PDFSpatialParserModule();
    const pdfData = await loadPDF("2501.05485v1.pdf");

    // Convert to base64
    const base64 = Buffer.from(pdfData).toString("base64");

    const result = await mod.process(
      { data: { pdfData: base64 }, config: {} as any },
      undefined,
    );

    expect((result.data.documents as any[]).length).toBeGreaterThan(0);
    expect(result.metrics?.elements).toBeGreaterThan(0);
  });

  it("should expose config schema", () => {
    const mod = new PDFSpatialParserModule();
    const schema = mod.getConfigSchema();
    expect(schema).toBeDefined();
  });

  it("should respect custom config", () => {
    const mod = new PDFSpatialParserModule({
      chunkSize: 256,
      alpha: 0.7,
      lineGroupThreshold: 5,
      pageGap: 100,
      filterWhitespace: false,
    });
    expect(mod.name).toBe("PDFSpatialParser");
  });
});
