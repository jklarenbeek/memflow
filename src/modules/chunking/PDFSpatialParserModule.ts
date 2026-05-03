/**
 * PDFSpatialParserModule — workflow adapter for the PDFSpatialParser
 *
 * Accepts PDF binary data (Uint8Array or base64 string) and produces
 * spatially-tagged atomic Documents with bbox metadata, ready for
 * downstream S2 spectral clustering.
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { PDFSpatialParser } from "./PDFSpatialParser.js";

const ConfigSchema = z.object({
  chunkSize: z.number().default(512),
  alpha: z.number().min(0).max(1).default(0.5),
  useEigengap: z.boolean().default(true),
  lineGroupThreshold: z.number().default(2),
  pageGap: z.number().default(50),
  filterWhitespace: z.boolean().default(true),
});

type ParserConfig = z.infer<typeof ConfigSchema>;

export class PDFSpatialParserModule implements BaseModule<ParserConfig> {
  readonly name = "PDFSpatialParser";
  readonly version = "0.5.0";
  private config: ParserConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<ParserConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;

    // Accept pdfData as Uint8Array or base64 string
    let pdfData: Uint8Array | undefined;
    const rawData = input.data.pdfData;

    if (rawData instanceof Uint8Array) {
      pdfData = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      pdfData = new Uint8Array(rawData);
    } else if (typeof rawData === "string" && rawData.length > 0) {
      // Decode base64
      const binary = atob(rawData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      pdfData = bytes;
    }

    if (!pdfData || pdfData.length === 0) {
      return { data: { documents: [] }, metrics: { elements: 0, pages: 0 } };
    }

    const parser = new PDFSpatialParser({
      chunkSize: this.config.chunkSize,
      alpha: this.config.alpha,
      useEigengap: this.config.useEigengap,
      lineGroupThreshold: this.config.lineGroupThreshold,
      pageGap: this.config.pageGap,
      filterWhitespace: this.config.filterWhitespace,
      embedder: ctx
        ? async (texts: string[]) => ctx.getEmbeddings().embedDocuments(texts)
        : undefined,
    });

    const documents = await parser.parseToDocuments(pdfData);

    // Determine number of unique pages
    const pages = new Set(documents.map((d) => d.metadata.page)).size;

    return {
      data: { documents },
      metrics: { elements: documents.length, pages },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
