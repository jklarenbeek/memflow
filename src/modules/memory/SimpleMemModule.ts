/**
 * SimpleMemModule — LLM-driven memory extraction and online synthesis
 *
 * Adapted from HRW's MultiMemBuilder (extractMemoryUnits + synthesizeOnline).
 * Implements the SimpleMem paper's core contributions:
 *
 *  1. De-linearisation: LLM extracts 1-3 atomic facts per chunk, resolves
 *     pronouns, adds absolute timestamps
 *  2. Online Semantic Synthesis: merges chunks with >0.82 cosine similarity
 *     into higher-level abstractions (intra-session)
 *
 * This is the first stage of the 3-module memory pipeline:
 *   SimpleMem → LightMem → StructMem
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { Document } from "@langchain/core/documents";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Cosine similarity threshold for merging similar memories */
  synthesisThreshold: z.number().min(0).max(1).default(0.82),
  /** Compression ratio target (0.3 = keep ~30% of original tokens) */
  compressionRatio: z.number().min(0.1).max(1).default(0.3),
  /** Max characters to send to LLM for extraction */
  maxInputChars: z.number().default(2000),
  /** Number of recent memories to consider for synthesis */
  synthesisWindow: z.number().default(20),
  /** Sliding window size (number of chunks per window) — paper §2 */
  windowSize: z.number().min(1).default(5),
  /** Overlap between adjacent windows */
  windowOverlap: z.number().min(0).default(2),
});

type SimpleMemConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SimpleMemModule implements BaseModule<SimpleMemConfig> {
  readonly name = "SimpleMem";
  readonly version = "3.0.0";
  private config: SimpleMemConfig;
  private ctx?: WorkflowContext;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async init(context: unknown): Promise<void> {
    this.ctx = context as WorkflowContext;
  }

  async process(
    input: ModuleInput<SimpleMemConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = (context as WorkflowContext) ?? this.ctx!;
    const chunks: Document[] = (input.data.chunks ?? input.data.documents ?? []) as Document[];

    if (chunks.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { extracted: 0 } };
    }

    ctx.logger.info(`SimpleMem: Processing ${chunks.length} chunks`);
    const existing: MemoryUnit[] = (input.data.memoryUnits ?? []) as MemoryUnit[];
    let newUnits: MemoryUnit[] = [];

    // 1. Sliding window grouping (paper §2)
    //    Groups chunks into overlapping windows for temporal context
    const windows = this.createSlidingWindows(chunks);
    ctx.logger.debug(`SimpleMem: Created ${windows.length} sliding windows from ${chunks.length} chunks`);

    // 2. De-linearise: extract atomic memory units from each window
    for (const window of windows) {
      // Combine window chunks into a single context block
      const combinedText = window.map((c) => c.pageContent ?? "").join("\n---\n");
      const combinedChunk = new Document({
        pageContent: combinedText,
        metadata: { ...window[0]?.metadata, windowSize: window.length },
      });
      const extracted = await this.extractMemoryUnits(combinedChunk, ctx);
      newUnits.push(...extracted);
    }

    // 3. Online Semantic Synthesis: merge highly similar recent units
    let allUnits = [...existing, ...newUnits];
    allUnits = await this.synthesizeOnline(allUnits, ctx);

    // 4. Multi-view structured indexing (paper §2)
    //    Enrich each unit with lexical + symbolic indexes for downstream retrieval
    await this.structuredIndex(allUnits, ctx);

    const tokenSavings = chunks.reduce(
      (acc, c) => acc + (c.pageContent?.length ?? 0) / 4,
      0,
    ) - allUnits.reduce((acc, u) => acc + u.content.length / 4, 0);

    return {
      data: { memoryUnits: allUnits },
      metrics: {
        extracted: newUnits.length,
        synthesized: allUnits.length,
        tokenSavings: Math.max(0, Math.round(tokenSavings)),
        windows: windows.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // De-linearisation (SimpleMem F_theta)
  // -----------------------------------------------------------------------

  private async extractMemoryUnits(
    chunk: Document,
    ctx: WorkflowContext,
  ): Promise<MemoryUnit[]> {
    const text = chunk.pageContent?.substring(0, this.config.maxInputChars) ?? "";
    if (!text.trim()) return [];

    const llm = ctx.getLLM();
    const embeddings = ctx.getEmbeddings();

    const prompt = `Extract 1-3 self-contained factual memory units from the following text. For each:
- Resolve pronouns to actual names
- Add absolute timestamps if relative times are mentioned
- Format as JSON array: [{"content": "...", "type": "fact|event|summary", "confidence": 0.9}]

Text: ${text}`;

    try {
      const response = await llm.invoke([{ role: "user", content: prompt }]);
      const responseText =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const units = JSON.parse(jsonMatch[0]) as Array<{
          content: string;
          type?: string;
          confidence?: number;
        }>;

        const results: MemoryUnit[] = [];
        for (const u of units.slice(0, 3)) {
          const emb = await embeddings.embedQuery(u.content);
          results.push({
            id: uuidv4(),
            content: u.content,
            embedding: emb,
            timestamp: new Date(),
            type: (u.type as MemoryUnit["type"]) ?? "fact",
            metadata: {
              source: chunk.metadata?.source ?? "chunk",
              confidence: u.confidence ?? 0.8,
            },
          });
        }
        return results;
      }
    } catch (err) {
      ctx.logger.warn(`LLM extraction failed: ${(err as Error).message}`);
    }

    // Fallback: use chunk as single memory unit
    const emb = await embeddings.embedQuery(text.substring(0, 500));
    return [
      {
        id: uuidv4(),
        content: text.substring(0, 800),
        embedding: emb,
        timestamp: new Date(),
        type: "summary",
        metadata: {
          source: chunk.metadata?.source ?? "chunk",
          confidence: 0.7,
        },
      },
    ];
  }

  // -----------------------------------------------------------------------
  // Online Semantic Synthesis
  // -----------------------------------------------------------------------

  private async synthesizeOnline(
    memories: MemoryUnit[],
    ctx: WorkflowContext,
  ): Promise<MemoryUnit[]> {
    if (memories.length <= 1) return memories;

    const recent = memories.slice(-this.config.synthesisWindow);
    const older = memories.slice(0, -this.config.synthesisWindow);
    const merged: MemoryUnit[] = [];
    const used = new Set<string>();

    for (let i = 0; i < recent.length; i++) {
      if (used.has(recent[i].id)) continue;
      const group = [recent[i]];

      for (let j = i + 1; j < recent.length; j++) {
        if (used.has(recent[j].id)) continue;
        if (recent[i].embedding.length === 0 || recent[j].embedding.length === 0) continue;

        const sim = cosineSimilarity(recent[i].embedding, recent[j].embedding);
        if (sim > this.config.synthesisThreshold) {
          group.push(recent[j]);
          used.add(recent[j].id);
        }
      }

      if (group.length > 1) {
        // Merge similar units into a synthesis
        const synthContent = group.map((g) => g.content).join(" | ");
        const embeddings = ctx.getEmbeddings();
        const synthEmb = await embeddings.embedQuery(
          synthContent.substring(0, 1500),
        );

        merged.push({
          id: uuidv4(),
          content: `Synthesized: ${synthContent.substring(0, 600)}`,
          embedding: synthEmb,
          timestamp: new Date(),
          type: "summary",
          metadata: {
            source: "synthesis",
            originalIds: group.map((g) => g.id),
            confidence: 0.85,
          },
          relations: group.flatMap((g) => g.relations ?? []),
        });
      } else {
        merged.push(recent[i]);
      }
      used.add(recent[i].id);
    }

    return [...older, ...merged];
  }

  // -----------------------------------------------------------------------
  // Sliding windows (paper §2)
  // -----------------------------------------------------------------------

  /**
   * Group chunks into overlapping sliding windows.
   *
   * Per the SimpleMem paper, dialogue is segmented into overlapping
   * sliding windows of fixed length. Each window represents a short
   * contiguous span that serves as the basic processing unit.
   */
  private createSlidingWindows(chunks: Document[]): Document[][] {
    if (chunks.length <= this.config.windowSize) {
      return [chunks];
    }

    const windows: Document[][] = [];
    const step = Math.max(1, this.config.windowSize - this.config.windowOverlap);

    for (let i = 0; i < chunks.length; i += step) {
      const window = chunks.slice(i, i + this.config.windowSize);
      if (window.length > 0) windows.push(window);
    }

    return windows;
  }

  // -----------------------------------------------------------------------
  // Multi-view structured indexing (paper §2)
  // -----------------------------------------------------------------------

  /**
   * Enrich each memory unit with three complementary index representations:
   *
   *  1. Semantic Layer: dense embedding (already exists in unit.embedding)
   *  2. Lexical Layer: extracted keywords for sparse/exact matching
   *  3. Symbolic Layer: structured metadata (timestamps, entity types)
   *
   * These indexes enable LightRAGRetriever to query all three layers
   * for comprehensive multi-view retrieval.
   */
  private async structuredIndex(
    units: MemoryUnit[],
    _ctx: WorkflowContext,
  ): Promise<void> {
    for (const unit of units) {
      // Semantic layer: already populated via unit.embedding

      // Lexical layer: extract keywords via simple TF analysis
      const words = unit.content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const wordFreq = new Map<string, number>();
      for (const w of words) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
      // Top keywords by frequency
      unit.metadata.lexicalKeywords = [...wordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word]) => word);

      // Symbolic layer: structured metadata
      unit.metadata.symbolicIndex = {
        type: unit.type,
        timestamp: unit.timestamp instanceof Date
          ? unit.timestamp.toISOString()
          : String(unit.timestamp),
        source: unit.metadata.source ?? "unknown",
        confidence: unit.metadata.confidence ?? 0.8,
        hasRelations: (unit.relations?.length ?? 0) > 0,
      };
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return true;
  }
}