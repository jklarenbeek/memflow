/**
 * SleepConsolidationModule — LTM consolidation via LLM summarization
 *
 * Extracted from LightMem Tier 2→3 promotion. Consolidates topic segments
 * into long-term memory summaries using LLM-based synthesis with
 * soft-update semantics (newTs >= existingTs).
 *
 * === Improvement #14 (completion): Configurable similarity function ===
 * Uses the `similarity()` strategy dispatcher instead of direct
 * `cosineSimilarity()`. Supports cosine, euclidean, and dotProduct.
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
import { similarity, type SimilarityFunction } from "../../utils/similarity.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Maximum LTM entries to maintain */
  ltmMaxSize: z.number().default(1000),
  /** Similarity threshold for soft-update matching */
  softUpdateThreshold: z.number().min(0).max(1).default(0.8),
  /** LightMem §3.3: Per-entry update queue size n */
  updateQueueSize: z.number().default(5),
  /** Enable per-entry offline parallel update queues (paper-aligned mode) */
  enableOfflineQueues: z.boolean().default(true),
  /** Improvement #14: Similarity function strategy (cosine, euclidean, dotProduct) */
  similarityFunction: z.enum(["cosine", "euclidean", "dotProduct"]).default("cosine"),
});

type SleepConsolidationConfig = z.infer<typeof ConfigSchema>;

export class SleepConsolidationModule implements BaseModule<SleepConsolidationConfig> {
  readonly name = "SleepConsolidation";
  readonly version = "0.5.0";
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

    // Soft-update: merge with existing LTM using paper-aligned approach
    let ltm = [...existing];

    if (this.config.enableOfflineQueues) {
      // LightMem §3.3: Per-entry update queues with parallel offline update
      // Q(eᵢ) = Topk({eⱼ, sim(vᵢ, vⱼ)} | tⱼ ≥ tᵢ, j ≠ i) :n
      const allEntries = [...ltm, ...newLtmEntries];

      // 1. Build update queues: for each LTM entry, find topK newer similar entries
      const updateQueues = new Map<string, { target: MemoryUnit; sources: MemoryUnit[] }>();

      for (const entry of ltm) {
        if (entry.embedding.length === 0) continue;
        const entryTs = new Date(entry.timestamp).getTime();

        const queue = allEntries
          .filter((other) =>
            other.id !== entry.id &&
            other.embedding.length > 0 &&
            new Date(other.timestamp).getTime() >= entryTs // tⱼ ≥ tᵢ constraint
          )
          .map((other) => ({
            unit: other,
            sim: similarity(entry.embedding, other.embedding, this.config.similarityFunction as SimilarityFunction),
          }))
          .filter((s) => s.sim >= this.config.softUpdateThreshold)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, this.config.updateQueueSize)
          .map((s) => s.unit);

        if (queue.length > 0) {
          updateQueues.set(entry.id, { target: entry, sources: queue });
        }
      }

      // 2. Execute updates in parallel (queues are independent per entry)
      const updateResults = await Promise.allSettled(
        [...updateQueues.entries()].map(async ([entryId, { target, sources }]) => {
          // Use the most recent source's content as the update
          const bestSource = sources[0];
          const idx = ltm.findIndex((u) => u.id === entryId);
          if (idx >= 0 && bestSource) {
            ltm[idx] = {
              ...ltm[idx],
              content: bestSource.content,
              embedding: bestSource.embedding,
              timestamp: bestSource.timestamp,
              metadata: {
                ...ltm[idx].metadata,
                ...bestSource.metadata,
                softUpdated: true,
                updateQueueSize: sources.length,
              },
            };
          }
        }),
      );

      // 3. Add truly new entries (not matched to any existing)
      const updatedIds = new Set(updateQueues.keys());
      for (const newEntry of newLtmEntries) {
        const hasMatch = ltm.some(
          (e) =>
            e.embedding.length > 0 &&
            newEntry.embedding.length > 0 &&
            similarity(e.embedding, newEntry.embedding, this.config.similarityFunction as SimilarityFunction) >= this.config.softUpdateThreshold,
        );
        if (!hasMatch) {
          ltm.push(newEntry);
        }
      }

      ctx.logger.debug(
        `SleepConsolidation: ${updateQueues.size} entries updated via offline queues`,
      );
    } else {
      // Legacy mode: simple sequential soft-update
      for (const newEntry of newLtmEntries) {
        const newTs = new Date(newEntry.timestamp).getTime();
        let merged = false;

        for (let i = 0; i < ltm.length; i++) {
          if (ltm[i].embedding.length === 0 || newEntry.embedding.length === 0) continue;
          const sim = similarity(ltm[i].embedding, newEntry.embedding, this.config.similarityFunction as SimilarityFunction);
          if (sim >= this.config.softUpdateThreshold) {
            const existingTs = new Date(ltm[i].timestamp).getTime();
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
