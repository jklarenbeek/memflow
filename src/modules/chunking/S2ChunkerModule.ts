/**
 * S2ChunkerModule — workflow adapter for the S2Chunker TextSplitter
 *
 * Thin adapter that wraps the pure LangChain S2Chunker into the
 * BaseModule interface for use in workflow pipelines.
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { S2Chunker } from "./S2Chunker.js";

const ConfigSchema = z.object({
  alpha: z.number().min(0).max(1).default(0.5),
  chunkSize: z.number().default(512),
  chunkOverlap: z.number().default(50),
  useEigengap: z.boolean().default(true),
});

type S2Config = z.infer<typeof ConfigSchema>;

export class S2ChunkerModule implements BaseModule<S2Config> {
  readonly name = "S2Chunker";
  readonly version = "0.5.0";
  private config: S2Config;
  private chunker?: S2Chunker;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    const ctx = context as WorkflowContext;
    this.chunker = new S2Chunker({
      alpha: this.config.alpha,
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      useEigengap: this.config.useEigengap,
      embedder: async (texts: string[]) => ctx.getEmbeddings().embedDocuments(texts),
    });
  }

  async process(
    input: ModuleInput<S2Config>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? undefined;

    if (!this.chunker && ctx) {
      this.chunker = new S2Chunker({
        alpha: this.config.alpha,
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        useEigengap: this.config.useEigengap,
        embedder: async (texts: string[]) => ctx.getEmbeddings().embedDocuments(texts),
      });
    }

    const docs = (input.data.documents ?? []) as Document[];
    if (docs.length === 0 && input.data.markdown) {
      docs.push(
        new Document({ pageContent: input.data.markdown as string }),
      );
    }

    if (!this.chunker || docs.length === 0) {
      return { data: { chunks: [] }, metrics: { chunkCount: 0 } };
    }

    const chunks = await this.chunker.splitDocuments(docs);

    return {
      data: { chunks },
      metrics: {
        chunkCount: chunks.length,
        inputDocs: docs.length,
      },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}