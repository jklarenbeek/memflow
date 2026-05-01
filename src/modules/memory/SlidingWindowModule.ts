/**
 * SlidingWindowModule — overlapping window grouping for chunks
 *
 * Extracted from SimpleMem §2. Groups incoming document chunks into
 * overlapping sliding windows to provide temporal context for
 * downstream fact extraction.
 *
 * Reads:  chunks (Document[])
 * Writes: windowedChunks (Document[][])
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  windowSize: z.number().default(5),
  windowOverlap: z.number().default(2),
});

type SlidingWindowConfig = z.infer<typeof ConfigSchema>;

export class SlidingWindowModule implements BaseModule<SlidingWindowConfig> {
  readonly name = "SlidingWindow";
  readonly version = "0.2.0";
  private config: SlidingWindowConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SlidingWindowConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const chunks = (input.data.chunks ?? input.data.documents ?? []) as Document[];

    if (chunks.length === 0) {
      return { data: { windowedChunks: [] }, metrics: { windows: 0 } };
    }

    const step = Math.max(1, this.config.windowSize - this.config.windowOverlap);
    const windows: Document[][] = [];

    for (let i = 0; i < chunks.length; i += step) {
      const window = chunks.slice(i, i + this.config.windowSize);
      if (window.length > 0) windows.push(window);
    }

    ctx.logger.debug(
      `SlidingWindow: Created ${windows.length} windows from ${chunks.length} chunks (size=${this.config.windowSize}, overlap=${this.config.windowOverlap})`,
    );

    return {
      data: { windowedChunks: windows, chunks },
      metrics: { windows: windows.length, inputChunks: chunks.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
