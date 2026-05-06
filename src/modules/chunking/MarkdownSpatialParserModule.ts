/**
 * MarkdownSpatialParserModule — workflow adapter for the MarkdownSpatialParser
 *
 * Uses parseToDocuments() to split raw Markdown into spatially-tagged
 * atomic blocks. These blocks carry `centroid`, `blockType`, `headingPath`,
 * and `headingDepth` metadata — ready for downstream S2 spectral clustering.
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import { MarkdownSpatialParser } from "./MarkdownSpatialParser.js";

const ConfigSchema = z.object({
  xScale: z.number().default(2.0),
  yScale: z.number().default(1.0),
  chunkSize: z.number().default(512),
  alpha: z.number().min(0).max(1).default(0.5),
  filePath: z.string().optional(),
});

type ParserConfig = z.infer<typeof ConfigSchema>;

export class MarkdownSpatialParserModule implements BaseModule<ParserConfig> {
  readonly name = "MarkdownSpatialParser";
  readonly version = "0.5.0";
  private config: ParserConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<ParserConfig>,
    _context: unknown,
  ): Promise<ModuleOutput> {
    let markdown = (input.data.markdown as string) ?? "";

    // Fallback: read from filePath in config (used by ingestion pipeline)
    if (!markdown.trim() && this.config.filePath) {
      const { readFile } = await import("fs/promises");
      try {
        markdown = await readFile(this.config.filePath, "utf-8");
      } catch (err) {
        return { data: { documents: [] }, metrics: { elements: 0, error: `Failed to read file: ${(err as Error).message}` } };
      }
    }

    if (!markdown.trim()) {
      return { data: { documents: [] }, metrics: { elements: 0 } };
    }

    const parser = new MarkdownSpatialParser({
      xScale: this.config.xScale,
      yScale: this.config.yScale,
      chunkSize: this.config.chunkSize,
      alpha: this.config.alpha,
    });
    const documents = parser.parseToDocuments(markdown);

    return {
      data: { documents },
      metrics: { elements: documents.length },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}