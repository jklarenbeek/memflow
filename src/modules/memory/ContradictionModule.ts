/**
 * ContradictionModule — detect and supersede conflicting memories
 *
 * Uses LLM to compare memory pairs and identify contradictions.
 * When found, marks the older memory as superseded and creates a
 * resolution memory with the updated fact.
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";

const ConfigSchema = z.object({
  similarityThreshold: z.number().default(0.75),
  enabled: z.boolean().default(true),
  maxPairs: z.number().default(20),
});

type Config = z.infer<typeof ConfigSchema>;

export class ContradictionModule implements BaseModule<Config> {
  readonly name = "Contradiction";
  readonly version = "0.5.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    if (!this.config.enabled) {
      return { data: {}, metrics: { contradictions: 0 } };
    }

    try {
      const units = await ctx.memgraph.query<{ id: string; content: string; embedding: number[]; timestamp: string; type: string }>(
        `MATCH (m:MemoryUnit)
         WHERE m.deletedAt IS NULL AND m.supersededBy IS NULL
         RETURN m.id AS id, m.content AS content, m.embedding AS embedding,
                m.timestamp AS timestamp, m.type AS type
         LIMIT 100`,
      );

      const candidates: Array<{ a: typeof units[0]; b: typeof units[0]; similarity: number }> = [];

      for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
          const a = units[i];
          const b = units[j];
          if (!a.embedding || !b.embedding) continue;
          const sim = cosineSimilarity(a.embedding, b.embedding);
          if (sim >= this.config.similarityThreshold) {
            candidates.push({ a, b, similarity: sim });
          }
        }
      }

      // Sort by similarity and limit pairs to check
      candidates.sort((x, y) => y.similarity - x.similarity);
      const pairsToCheck = candidates.slice(0, this.config.maxPairs);

      let contradictions = 0;
      const llm = ctx.getLLM();

      for (const pair of pairsToCheck) {
        try {
          const prompt = [
            { type: "system" as const, content: "You are a contradiction detector. Respond with JSON only: {contradiction: boolean, reason: string, resolution: string}" },
            { type: "user" as const, content: `Memory A: "${pair.a.content}"\nMemory B: "${pair.b.content}"\nDo these contradict?` },
          ];

          const resp = await llm.invoke(prompt);
          const text = typeof resp.content === "string" ? resp.content : "";
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
            contradiction?: boolean;
            reason?: string;
            resolution?: string;
          };

          if (parsed.contradiction) {
            // Determine which memory is older
            const older = new Date(pair.a.timestamp) <= new Date(pair.b.timestamp) ? pair.a : pair.b;
            const newer = older.id === pair.a.id ? pair.b : pair.a;

            await ctx.memgraph.query(
              `MATCH (old:MemoryUnit {id: $oldId})
               MATCH (new:MemoryUnit {id: $newId})
               SET old.supersededBy = $newId,
                   old.supersededAt = $timestamp,
                   old.supersededReason = $reason
               MERGE (res:MemoryUnit {id: $resId})
               SET res.content = $resolution,
                   res.type = "summary",
                   res.timestamp = $timestamp,
                   res.source = "contradiction-resolution",
                   res.resolvedFrom = [old.id, new.id]`,
              {
                oldId: older.id,
                newId: newer.id,
                resId: `resolution-${Date.now()}-${contradictions}`,
                reason: parsed.reason ?? "contradiction detected",
                resolution: parsed.resolution ?? newer.content,
                timestamp: new Date().toISOString(),
              },
            );

            contradictions++;
          }
        } catch (err) {
          ctx.logger.debug(`ContradictionModule: LLM check failed for pair: ${(err as Error).message}`);
        }
      }

      ctx.logger.info(`ContradictionModule: Found ${contradictions} contradictions`);

      return {
        data: {},
        metrics: { contradictions, pairsChecked: pairsToCheck.length },
      };
    } catch (err) {
      ctx.logger.warn(`ContradictionModule: failed: ${(err as Error).message}`);
      return { data: {}, metrics: { contradictions: 0, error: 1 } };
    }
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return true;
  }
}
