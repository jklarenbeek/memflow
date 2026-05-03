/**
 * DOCXSpatialParser unit tests
 *
 * Tests the DOCX parsing, AST→spatial-block conversion, and S2 pipeline
 * integration using a pre-built DOCX fixture in docs/refs/.
 *
 * The fixture contains:
 *   H1 "Introduction"
 *     paragraph
 *     H2 "Background"
 *       paragraph
 *       H3 "Historical Context"
 *         paragraph
 *         3 list items (2× indent 0, 1× indent 1)
 *         table (2×2)
 *   H1 "Conclusion"
 *     paragraph
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { resolve } from "path";
import { readFile } from "fs/promises";
import { DOCXSpatialParser } from "../../modules/chunking/DOCXSpatialParser.js";
import { DOCXSpatialParserModule } from "../../modules/chunking/DOCXSpatialParserModule.js";
import type { Document } from "@langchain/core/documents";
import type { DocxBlockMetadata } from "../../modules/chunking/DOCXSpatialParser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFS_DIR = resolve(import.meta.dir, "../../../docs/refs");

async function loadDOCX(filename: string): Promise<Buffer> {
  return readFile(resolve(REFS_DIR, filename));
}

// ---------------------------------------------------------------------------
// DOCXSpatialParser — core class tests
// ---------------------------------------------------------------------------

describe("DOCXSpatialParser", () => {
  let docxBuffer: Buffer;

  beforeAll(async () => {
    docxBuffer = await loadDOCX("test-docx-fixture.docx");
  });

  describe("splitText() throws", () => {
    it("should throw when called with a text string", async () => {
      const parser = new DOCXSpatialParser();
      expect(parser.splitText("hello world")).rejects.toThrow(
        "use splitDOCX(docxBytes)",
      );
    });
  });

  describe("parseToDocuments — structural extraction", () => {
    let docs: Document[];

    beforeAll(async () => {
      const parser = new DOCXSpatialParser({
        chunkSize: 500,
        xScale: 2.0,
        yScale: 1.0,
      });
      docs = await parser.parseToDocuments(docxBuffer);
    });

    it("should produce the expected number of blocks", () => {
      // 4 headings + 3 paragraphs + 3 list items + 1 table = 11 blocks
      // (empty paragraphs are skipped)
      expect(docs.length).toBeGreaterThanOrEqual(10);
      expect(docs.length).toBeLessThanOrEqual(14);
    });

    it("should produce documents with centroid metadata", () => {
      for (const doc of docs) {
        const meta = doc.metadata as DocxBlockMetadata;
        expect(meta.centroid).toBeDefined();
        expect(typeof meta.centroid.x).toBe("number");
        expect(typeof meta.centroid.y).toBe("number");
      }
    });

    it("should produce documents with blockType metadata", () => {
      for (const doc of docs) {
        const meta = doc.metadata as DocxBlockMetadata;
        expect(meta.blockType).toBeDefined();
        expect(typeof meta.blockType).toBe("string");
      }
    });

    it("should produce documents with headingPath and headingDepth", () => {
      for (const doc of docs) {
        const meta = doc.metadata as DocxBlockMetadata;
        expect(Array.isArray(meta.headingPath)).toBe(true);
        expect(typeof meta.headingDepth).toBe("number");
      }
    });

    it("should identify heading blocks with correct levels", () => {
      const headings = docs.filter(d =>
        (d.metadata as DocxBlockMetadata).blockType.startsWith("heading_")
      );
      expect(headings.length).toBeGreaterThanOrEqual(4);

      const h1s = headings.filter(h => (h.metadata as DocxBlockMetadata).blockType === "heading_1");
      const h2s = headings.filter(h => (h.metadata as DocxBlockMetadata).blockType === "heading_2");
      const h3s = headings.filter(h => (h.metadata as DocxBlockMetadata).blockType === "heading_3");

      expect(h1s.length).toBe(2); // Introduction, Conclusion
      expect(h2s.length).toBe(1); // Background
      expect(h3s.length).toBe(1); // Historical Context
    });

    it("should identify list_item blocks", () => {
      const lists = docs.filter(d =>
        (d.metadata as DocxBlockMetadata).blockType === "list_item"
      );
      expect(lists.length).toBe(3);
    });

    it("should identify table blocks", () => {
      const tables = docs.filter(d =>
        (d.metadata as DocxBlockMetadata).blockType === "table"
      );
      expect(tables.length).toBe(1);

      // Table content should include Markdown formatting
      expect(tables[0].pageContent).toContain("Name");
      expect(tables[0].pageContent).toContain("Value");
      expect(tables[0].pageContent).toContain("|");
    });

    it("should build correct heading paths", () => {
      // Find the paragraph under H3 "Historical Context"
      const h3Para = docs.find(d =>
        d.pageContent.includes("Paragraph under heading 3")
      );
      expect(h3Para).toBeDefined();
      const meta = h3Para!.metadata as DocxBlockMetadata;
      expect(meta.headingPath).toEqual(["Introduction", "Background", "Historical Context"]);
      expect(meta.headingDepth).toBe(2); // H3 → depth 2
    });

    it("should reset heading path after a new H1", () => {
      const conclusion = docs.find(d => d.pageContent === "Conclusion");
      expect(conclusion).toBeDefined();
      const meta = conclusion!.metadata as DocxBlockMetadata;
      expect(meta.headingPath).toEqual(["Conclusion"]);
    });

    it("should assign x=0 for H1 headings", () => {
      const h1s = docs.filter(d =>
        (d.metadata as DocxBlockMetadata).blockType === "heading_1"
      );
      for (const h1 of h1s) {
        // x = (level-1) * xScale = 0 * 2.0 = 0
        expect((h1.metadata as DocxBlockMetadata).centroid.x).toBe(0);
      }
    });

    it("should assign increasing y for sequential blocks", () => {
      for (let i = 1; i < docs.length; i++) {
        const prevY = (docs[i - 1].metadata as DocxBlockMetadata).centroid.y;
        const currY = (docs[i].metadata as DocxBlockMetadata).centroid.y;
        expect(currY).toBeGreaterThan(prevY);
      }
    });

    it("should give tables a depth offset of +0.5", () => {
      const table = docs.find(d =>
        (d.metadata as DocxBlockMetadata).blockType === "table"
      );
      expect(table).toBeDefined();
      const meta = table!.metadata as DocxBlockMetadata;
      // Under H3 (currentDepth=2), table x = (2 + 0.5) * xScale = 5.0
      expect(meta.centroid.x).toBe(5.0);
    });
  });

  describe("parseToDocuments — non-empty content", () => {
    it("should have non-empty pageContent for all blocks", async () => {
      const parser = new DOCXSpatialParser();
      const docs = await parser.parseToDocuments(docxBuffer);
      for (const doc of docs) {
        expect(doc.pageContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe("reusability", () => {
    it("should allow multiple calls with the same data", async () => {
      const parser = new DOCXSpatialParser({ chunkSize: 500 });
      const docs1 = await parser.parseToDocuments(docxBuffer);
      const docs2 = await parser.parseToDocuments(docxBuffer);
      expect(docs1.length).toBe(docs2.length);
    });
  });

  describe("input format handling", () => {
    it("should accept Uint8Array input", async () => {
      const parser = new DOCXSpatialParser();
      const uint8 = new Uint8Array(docxBuffer);
      const docs = await parser.parseToDocuments(uint8);
      expect(docs.length).toBeGreaterThan(0);
    });

    it("should accept ArrayBuffer input", async () => {
      const parser = new DOCXSpatialParser();
      const ab = docxBuffer.buffer.slice(
        docxBuffer.byteOffset,
        docxBuffer.byteOffset + docxBuffer.byteLength,
      );
      const docs = await parser.parseToDocuments(ab);
      expect(docs.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// DOCXSpatialParserModule — workflow adapter tests
// ---------------------------------------------------------------------------

describe("DOCXSpatialParserModule", () => {
  let docxBuffer: Buffer;

  beforeAll(async () => {
    docxBuffer = await loadDOCX("test-docx-fixture.docx");
  });

  it("should instantiate with default config", () => {
    const mod = new DOCXSpatialParserModule();
    expect(mod.name).toBe("DOCXSpatialParser");
    expect(mod.version).toBe("0.5.1");
  });

  it("should return empty result for missing docxData", async () => {
    const mod = new DOCXSpatialParserModule();
    const result = await mod.process(
      { data: {}, config: {} as any },
      undefined,
    );
    expect(result.data.documents).toEqual([]);
    expect(result.metrics?.elements).toBe(0);
  });

  it("should accept Buffer docxData", async () => {
    const mod = new DOCXSpatialParserModule();
    const result = await mod.process(
      { data: { docxData: docxBuffer }, config: {} as any },
      undefined,
    );
    expect((result.data.documents as any[]).length).toBeGreaterThan(0);
    expect(result.metrics?.elements).toBeGreaterThan(0);
  });

  it("should accept base64-encoded docxData", async () => {
    const mod = new DOCXSpatialParserModule();
    const base64 = docxBuffer.toString("base64");
    const result = await mod.process(
      { data: { docxData: base64 }, config: {} as any },
      undefined,
    );
    expect((result.data.documents as any[]).length).toBeGreaterThan(0);
    expect(result.metrics?.elements).toBeGreaterThan(0);
  });

  it("should report block type metrics", async () => {
    const mod = new DOCXSpatialParserModule();
    const result = await mod.process(
      { data: { docxData: docxBuffer }, config: {} as any },
      undefined,
    );
    expect(result.metrics?.blocks_heading_1).toBeGreaterThan(0);
    expect(result.metrics?.blocks_paragraph).toBeGreaterThan(0);
  });

  it("should expose config schema", () => {
    const mod = new DOCXSpatialParserModule();
    const schema = mod.getConfigSchema();
    expect(schema).toBeDefined();
  });

  it("should respect custom config", () => {
    const mod = new DOCXSpatialParserModule({
      chunkSize: 256,
      alpha: 0.7,
      xScale: 3.0,
      yScale: 0.5,
    });
    expect(mod.name).toBe("DOCXSpatialParser");
  });
});
