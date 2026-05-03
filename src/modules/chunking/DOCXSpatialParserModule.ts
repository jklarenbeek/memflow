/**
 * DOCXSpatialParserModule — workflow adapter for the DOCXSpatialParser
 *
 * Accepts DOCX binary data (Buffer, Uint8Array, ArrayBuffer, or base64 string)
 * and produces spatially-tagged atomic Documents with centroid metadata,
 * ready for downstream S2 spectral clustering.
 *
 * Follows the same pattern as PDFSpatialParserModule and
 * MarkdownSpatialParserModule.
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { DOCXSpatialParser } from "./DOCXSpatialParser.js";

const ConfigSchema = z.object({
  chunkSize: z.number().default(512),
  alpha: z.number().min(0).max(1).default(0.5),
  useEigengap: z.boolean().default(true),
  xScale: z.number().default(2.0),
  yScale: z.number().default(1.0),
});

type ParserConfig = z.infer<typeof ConfigSchema>;

export class DOCXSpatialParserModule implements BaseModule<ParserConfig> {
  readonly name = "DOCXSpatialParser";
  readonly version = "0.5.1";
  private config: ParserConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<ParserConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;

    // Accept docxData as Buffer, Uint8Array, ArrayBuffer, or base64 string
    let docxData: Buffer | undefined;
    const rawData = input.data.docxData;

    if (Buffer.isBuffer(rawData)) {
      docxData = rawData;
    } else if (rawData instanceof Uint8Array) {
      docxData = Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    } else if (rawData instanceof ArrayBuffer) {
      docxData = Buffer.from(rawData);
    } else if (typeof rawData === "string" && rawData.length > 0) {
      // Decode base64
      docxData = Buffer.from(rawData, "base64");
    }

    if (!docxData || docxData.length === 0) {
      return { data: { documents: [] }, metrics: { elements: 0 } };
    }

    const parser = new DOCXSpatialParser({
      chunkSize: this.config.chunkSize,
      alpha: this.config.alpha,
      useEigengap: this.config.useEigengap,
      xScale: this.config.xScale,
      yScale: this.config.yScale,
      embedder: ctx
        ? async (texts: string[]) => ctx.getEmbeddings().embedDocuments(texts)
        : undefined,
    });

    const documents = await parser.parseToDocuments(docxData);

    // Count block types for metrics (flattened to scalar values)
    const metrics: Record<string, number> = { elements: documents.length };
    for (const doc of documents) {
      const key = `blocks_${doc.metadata.blockType as string}`;
      metrics[key] = (metrics[key] ?? 0) + 1;
    }

    return {
      data: { documents },
      metrics,
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
