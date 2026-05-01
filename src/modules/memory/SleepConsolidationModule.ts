/**
 * SleepConsolidationModule — LTM consolidation via LLM summarization
 *
 * Extracted from LightMem Tier 2→3 promotion. Consolidates topic segments
 * into long-term memory summaries using LLM-based synthesis with
 * soft-update semantics (newTs >= existingTs).
 *
 * Reads:  topicSegments (MemoryUnit[][]), memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — consolidated LTM entries
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
import { cosineSimilarity } from "../../utils/similarity.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Maximum LTM entries to maintain */
  ltmMaxSize: z.number().default(1000),
  /** Cosine threshold for soft-update matching */
  softUpdateThreshold: z.number().min(0).max(1).default(0.8),
});

type SleepConsolidationConfig = z.infer<typeof ConfigSchema>;

export class SleepConsolidationModule implements BaseModule<SleepConsolidationConfig> {
  readonly name = "SleepConsolidation";
  readonly version = "0.2.0";
  private config: SleepConsolidationConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SleepConsolidationConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const segments = (input.data.topicSegments ?? []) as MemoryUnit[][];
    const existing = [...((input.data.memoryUnits ?? []) as MemoryUnit[])];

    if (segments.length === 0) {
      return { data: { memoryUnits: existing }, metrics: { consolidated: 0 } };
    }

    const llm = ctx.getLLM();
    const embedder = ctx.getEmbeddings();
    let consolidated = 0;

    // Consolidate each segment in parallel
    const results = await Promise.allSettled(
      segments.map(async (segment) => {
        if (segment.length === 0) return null;

        const segmentText = segment
          .map((u) => u.content)
          .join("\n");

        try {
          const { messages } = loadAndRender("lightmem/consolidation", {
            segment_text: segmentText.substring(0, 3000),
            segment_count: segment.length,
          });

          const resp = await llm.invoke(messages);
          const summary = typeof resp.content === "string" ? resp.content : "";

          // Embed the consolidated summary
          let embedding: number[] = [];
          try {
            embedding = await embedder.embedQuery(summary.substring(0, 500));
          } catch { /* no embedding */ }

          const consolidatedUnit: MemoryUnit = {
            id: uuid(),
            content: summary.substring(0, 1000),
            embedding,
            timestamp: new Date(),
            type: "summary",
            metadata: {
              consolidatedFrom: segment.map((u) => u.id),
              segmentSize: segment.length,
              confidence: 0.85,
            },
          };

          return consolidatedUnit;
        } catch {
          return null;
        }
      }),
    );

    const newLtmEntries: MemoryUnit[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        newLtmEntries.push(result.value);
        consolidated++;
      }
    }

    // Soft-update: merge with existing LTM using timestamp constraint
    let ltm = [...existing];
    for (const newEntry of newLtmEntries) {
      const newTs = new Date(newEntry.timestamp).getTime();
      let merged = false;

      for (let i = 0; i < ltm.length; i++) {
        if (ltm[i].embedding.length === 0 || newEntry.embedding.length === 0) continue;
        const sim = cosineSimilarity(ltm[i].embedding, newEntry.embedding);
        if (sim >= this.config.softUpdateThreshold) {
          const existingTs = new Date(ltm[i].timestamp).getTime();
          // Only update if new timestamp >= existing (soft-update constraint)
          if (newTs >= existingTs) {
            ltm[i] = {
              ...ltm[i],
              content: newEntry.content,
              embedding: newEntry.embedding,
              timestamp: newEntry.timestamp,
              metadata: {
                ...ltm[i].metadata,
                ...newEntry.metadata,
                softUpdated: true,
              },
            };
          }
          merged = true;
          break;
        }
      }

      if (!merged) {
        ltm.push(newEntry);
      }
    }

    // Cap LTM size
    if (ltm.length > this.config.ltmMaxSize) {
      ltm = ltm.slice(-this.config.ltmMaxSize);
    }

    ctx.logger.info(
      `SleepConsolidation: Consolidated ${consolidated} segments, LTM size: ${ltm.length}`,
    );

    return {
      data: { memoryUnits: ltm },
      metrics: { consolidated, ltmSize: ltm.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
