/**
 * STMBufferModule — LightMem §3.2 Topic-Aware Short-Term Memory
 *
 * After topic segmentation, segments are stored in the STM buffer
 * with structure {topic, {sumᵢ, userᵢ, modelᵢ}}. When the STM token
 * count reaches the preset threshold, invokes LLM fsum to generate
 * concise summaries, building the final index structure stored in LTM:
 *
 *   sumᵢ = fsum(Sᵢ), Sᵢ ⊆ {userᵢ, modelᵢ}, Sᵢ ≠ ∅
 *   Entryᵢ = {topic, eᵢ := embedding(sumᵢ), userᵢ, modelᵢ}
 *
 * Reads:  topicSegments (MemoryUnit[][])
 * Writes: topicSegments (MemoryUnit[][]) — enriched with topic summaries
 *         memoryUnits (MemoryUnit[]) — STM-indexed entries ready for LTM
 */

import { z } from "zod";
import { v4 as uuid } from "uuid";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** STM capacity in tokens — triggers summarization when exceeded */
  stmCapacity: z.number().default(2048),
  /** Chars-per-token approximation */
  charsPerToken: z.number().default(4),
  /** Max segments to summarize in one batch */
  maxBatchSize: z.number().default(10),
});

type STMBufferConfig = z.infer<typeof ConfigSchema>;

interface STMState {
  segments: MemoryUnit[][];
  totalTokens: number;
  lastUpdate: string;
}

export class STMBufferModule implements BaseModule<STMBufferConfig> {
  readonly name = "STMBuffer";
  readonly version = "0.2.0";
  private config: STMBufferConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<STMBufferConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const incoming = (input.data.topicSegments ?? []) as MemoryUnit[][];

    if (incoming.length === 0) {
      return {
        data: { topicSegments: [], memoryUnits: input.data.memoryUnits ?? [] },
        metrics: { stmPromoted: 0 },
      };
    }

    // Load existing STM buffer from StateStore
    const storeKey = `stm::${ctx.workflowId ?? "default"}`;
    let stm: STMState;

    try {
      const results = await ctx.memgraph.query<{ value: string }>(
        `MATCH (s:ModuleState {workflowId: $wfId, moduleKey: $key})
         RETURN s.value AS value`,
        { wfId: ctx.workflowId, key: storeKey },
      );
      stm = results.length > 0 && results[0].value
        ? (JSON.parse(results[0].value) as STMState)
        : { segments: [], totalTokens: 0, lastUpdate: new Date().toISOString() };
    } catch {
      stm = { segments: [], totalTokens: 0, lastUpdate: new Date().toISOString() };
    }

    // Accumulate incoming segments
    for (const segment of incoming) {
      const segTokens = segment.reduce(
        (sum, u) => sum + Math.ceil(u.content.length / this.config.charsPerToken),
        0,
      );
      stm.segments.push(segment);
      stm.totalTokens += segTokens;
    }

    stm.lastUpdate = new Date().toISOString();

    // Check if STM buffer needs promotion to LTM
    if (stm.totalTokens < this.config.stmCapacity) {
      // Not full — persist and pass through
      try {
        await ctx.memgraph.query(
          `MERGE (s:ModuleState {workflowId: $wfId, moduleKey: $key})
           SET s.value = $value, s.updatedAt = $updatedAt`,
          { wfId: ctx.workflowId, key: storeKey, value: JSON.stringify(stm), updatedAt: new Date().toISOString() },
        );
      } catch { /* continue */ }

      ctx.logger.debug(
        `STMBuffer: Accumulated ${stm.segments.length} segments ` +
          `(${stm.totalTokens}/${this.config.stmCapacity} tokens)`,
      );

      return {
        data: { topicSegments: incoming, memoryUnits: input.data.memoryUnits ?? [] },
        metrics: { stmPromoted: 0, stmBuffered: stm.segments.length },
      };
    }

    // STM is full — summarize and promote to LTM format
    const llm = ctx.getLLM();
    const embedder = ctx.getEmbeddings();
    const promotedUnits: MemoryUnit[] = [];
    const segmentsToProcess = stm.segments.slice(0, this.config.maxBatchSize);

    const results = await Promise.allSettled(
      segmentsToProcess.map(async (segment, segIdx) => {
        if (segment.length === 0) return null;

        // Build topic label from segment content
        const segmentText = segment.map((u) => u.content).join("\n");
        const topicLabel = await this.extractTopicLabel(segmentText, ctx);

        // Generate summary: sumᵢ = fsum(Sᵢ)
        let summary: string;
        try {
          const { messages } = loadAndRender("lightmem/consolidation", {
            segment_text: segmentText.substring(0, 3000),
            segment_count: segment.length,
          });
          const resp = await llm.invoke(messages);
          summary = typeof resp.content === "string"
            ? resp.content.substring(0, 800)
            : segmentText.substring(0, 400);
        } catch {
          summary = segmentText.substring(0, 400);
        }

        // Embed summary: eᵢ := embedding(sumᵢ)
        let embedding: number[] = [];
        try {
          embedding = await embedder.embedQuery(summary.substring(0, 500));
        } catch { /* no embedding */ }

        // Build LTM entry: {topic, eᵢ, userᵢ, modelᵢ}
        const ltmEntry: MemoryUnit = {
          id: uuid(),
          content: summary,
          embedding,
          timestamp: new Date(),
          type: "summary",
          metadata: {
            topic: topicLabel,
            segmentIndex: segIdx,
            sourceUnitIds: segment.map((u) => u.id),
            segmentSize: segment.length,
            stmPromoted: true,
            confidence: 0.85,
          },
        };

        return ltmEntry;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        promotedUnits.push(result.value);
      }
    }

    // Reset STM buffer — keep any overflow segments
    const overflow = stm.segments.slice(this.config.maxBatchSize);
    const overflowTokens = overflow.reduce(
      (sum, seg) =>
        sum +
        seg.reduce(
          (s, u) => s + Math.ceil(u.content.length / this.config.charsPerToken),
          0,
        ),
      0,
    );

    const newStm: STMState = {
      segments: overflow,
      totalTokens: overflowTokens,
      lastUpdate: new Date().toISOString(),
    };

    try {
      await ctx.memgraph.query(
        `MERGE (s:ModuleState {workflowId: $wfId, moduleKey: $key})
         SET s.value = $value, s.updatedAt = $updatedAt`,
        { wfId: ctx.workflowId, key: storeKey, value: JSON.stringify(newStm), updatedAt: new Date().toISOString() },
      );
    } catch { /* continue */ }

    const existingUnits = (input.data.memoryUnits ?? []) as MemoryUnit[];

    ctx.logger.info(
      `STMBuffer: Promoted ${promotedUnits.length} segments to LTM format ` +
        `(${stm.totalTokens} tokens), ${overflow.length} segments carried over`,
    );

    return {
      data: {
        topicSegments: incoming,
        memoryUnits: [...existingUnits, ...promotedUnits],
      },
      metrics: {
        stmPromoted: promotedUnits.length,
        stmOverflow: overflow.length,
      },
    };
  }

  /**
   * Extract a concise topic label from segment text.
   * Falls back to first 5 meaningful words if LLM fails.
   */
  private async extractTopicLabel(
    text: string,
    ctx: WorkflowContext,
  ): Promise<string> {
    try {
      const llm = ctx.getLLM();
      const resp = await llm.invoke([
        {
          role: "system",
          content: "Extract a 2-5 word topic label from the text. Reply with ONLY the label.",
        },
        { role: "user", content: text.substring(0, 500) },
      ]);
      const label = typeof resp.content === "string" ? resp.content.trim() : "";
      return label.length > 0 && label.length < 60 ? label : this.fallbackTopicLabel(text);
    } catch {
      return this.fallbackTopicLabel(text);
    }
  }

  private fallbackTopicLabel(text: string): string {
    const words = text
      .replace(/[^a-zA-Z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    return words.slice(0, 5).join(" ") || "general";
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
