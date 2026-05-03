/**
 * DOCXSpatialParser unit tests
 *
 * Tests the DOCX parsing, AST→spatial-block conversion, and S2 pipeline
 * integration using the memflow-s2chunker.docx reference file.
 *
 * The fixture (docs/refs/memflow-s2chunker.docx) is a Google Docs-exported
 * DOCX describing the S² chunking architecture. It contains:
 *   - 1× H1 (title)
 *   - 8× H2 (sections: Abstract, Introduction, Architecture, etc.)
 *   - 5× H3 (sub-sections: Core Pipeline, Spatial Coordinate Model, etc.)
 *   - 16× paragraphs (body text)
 *   - 21× list items (ordered + unordered)
 *   - 1× table (Library Decision Matrix)
 *   = 52 total content nodes
 *
 * The DOCX uses numeric style IDs (749, 750, 751) rather than standard
 * "Heading1" IDs — tests verify that DOCXSpatialParser's Google Docs compat
 * heading extraction works correctly.
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
    docxBuffer = await loadDOCX("memflow-s2chunker.docx");
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
      // 14 headings + 16 paragraphs + 21 list items + 1 table = 52 blocks
      expect(docs.length).toBe(52);
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
      expect(headings.length).toBe(14);

      const h1s = headings.filter(h => (h.metadata as DocxBlockMetadata).blockType === "heading_1");
      const h2s = headings.filter(h => (h.metadata as DocxBlockMetadata).blockType === "heading_2");
      const h3s = headings.filter(h => (h.metadata as DocxBlockMetadata).blockType === "heading_3");

      expect(h1s.length).toBe(1);  // Title
      expect(h2s.length).toBe(8);  // Abstract, 1..7 sections
      expect(h3s.length).toBe(5);  // Sub-sections (2.1, 2.2, 3.1, 3.2, 3.3)
    });

    it("should identify list_item blocks", () => {
      const lists = docs.filter(d =>
        (d.metadata as DocxBlockMetadata).blockType === "list_item"
      );
      expect(lists.length).toBe(21);
    });

    it("should identify table blocks", () => {
      const tables = docs.filter(d =>
        (d.metadata as DocxBlockMetadata).blockType === "table"
      );
      expect(tables.length).toBe(1);

      // Table content should include Markdown formatting
      expect(tables[0].pageContent).toContain("|");
    });

    it("should build correct heading paths", () => {
      // Find a paragraph under H3 "2.1 Core Pipeline"
      const pipelineList = docs.find(d =>
        d.pageContent.startsWith("Parse: Format-specific parsers")
      );
      expect(pipelineList).toBeDefined();
      const meta = pipelineList!.metadata as DocxBlockMetadata;
      // H1 title → H2 "2. The S2Chunker Architecture" → H3 "2.1 Core Pipeline"
      expect(meta.headingPath.length).toBe(3);
      expect(meta.headingPath[2]).toContain("2.1 Core Pipeline");
    });

    it("should reset heading path after a new H2", () => {
      // "4. Library Decision Matrix" is a new H2 — its path should reset
      const libDecision = docs.find(d =>
        d.pageContent.includes("4. Library Decision Matrix")
      );
      expect(libDecision).toBeDefined();
      const meta = libDecision!.metadata as DocxBlockMetadata;
      // Under H1, direct H2 → path length 2
      expect(meta.headingPath.length).toBe(2);
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

    it("should detect Google Docs numeric heading styles", () => {
      // The H1 title uses style "749" which maps to "Heading 1"
      const title = docs.find(d =>
        (d.metadata as DocxBlockMetadata).blockType === "heading_1"
      );
      expect(title).toBeDefined();
      expect(title!.pageContent).toContain("S²");
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
      ) as ArrayBuffer;
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
    docxBuffer = await loadDOCX("memflow-s2chunker.docx");
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
