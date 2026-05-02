/**
 * SemanticSynthesisModule — SimpleMem §2.2 Online Semantic Synthesis
 *
 * Upgraded from pairwise cosine merge to LLM-based session-scoped
 * consolidation. Identifies clusters of semantically similar memory
 * units and merges them into coherent entries using LLM synthesis.
 *
 * Paper spec: Fsyn(Osession, Ccontext; f) — operates on session scope,
 * merging scattered fragments into coherent wholes using conversational
 * context. Example: "wants coffee" + "prefers oat milk" + "likes hot"
 * → "prefers hot coffee with oat milk"
 *
 * Falls back to original pairwise cosine + string concatenation when
 * LLM is unavailable.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — deduplicated/merged
 */

import { z } from "zod";
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
  /** Similarity threshold for merging (strictly greater than) */
  synthesisThreshold: z.number().min(0).max(1).default(0.82),
  /** Use LLM for intelligent synthesis (falls back to pairwise concat) */
  useLLM: z.boolean().default(true),
  /** Similarity function for cluster detection (Improvement #14) */
  similarityFunction: z.enum(["cosine", "euclidean", "dotProduct"]).default("cosine"),
});

type SemanticSynthesisConfig = z.infer<typeof ConfigSchema>;

export class SemanticSynthesisModule implements BaseModule<SemanticSynthesisConfig> {
  readonly name = "SemanticSynthesis";
  readonly version = "0.5.0";
  private config: SemanticSynthesisConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SemanticSynthesisConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = [...((input.data.memoryUnits ?? []) as MemoryUnit[])];

    if (units.length <= 1) {
      return { data: { memoryUnits: units }, metrics: { merged: 0 } };
    }

    // Step 1: Build clusters of related units via cosine similarity
    const clusters = this.buildClusters(units);

    if (clusters.length === units.length) {
      // No merges found — all units are distinct
      return { data: { memoryUnits: units }, metrics: { merged: 0, clusters: clusters.length } };
    }

    // Step 2: Synthesize each cluster
    const result: MemoryUnit[] = [];
    let mergeCount = 0;

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        result.push(cluster[0]);
        continue;
      }

      // Multi-unit cluster — synthesize
      mergeCount += cluster.length - 1;

      if (this.config.useLLM) {
        const synthesized = await this.llmSynthesize(cluster, ctx);
        result.push(synthesized);
      } else {
        result.push(this.pairwiseMerge(cluster));
      }
    }

    ctx.logger.info(
      `SemanticSynthesis: ${clusters.length} clusters from ${units.length} units, ` +
        `${mergeCount} merged (LLM=${this.config.useLLM})`,
    );

    return {
      data: { memoryUnits: result },
      metrics: { merged: mergeCount, before: units.length, after: result.length, clusters: clusters.length },
    };
  }

  /**
   * Build clusters of units whose pairwise cosine similarity exceeds threshold.
   * Uses union-find for transitive closure.
   */
  private buildClusters(units: MemoryUnit[]): MemoryUnit[][] {
    const n = units.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };

    for (let i = 0; i < n; i++) {
      if (units[i].embedding.length === 0) continue;
      for (let j = i + 1; j < n; j++) {
        if (units[j].embedding.length === 0) continue;
        const sim = similarity(units[i].embedding, units[j].embedding, this.config.similarityFunction as SimilarityFunction);
        if (sim > this.config.synthesisThreshold) {
          union(i, j);
        }
      }
    }

    const groups = new Map<number, MemoryUnit[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(units[i]);
    }

    return [...groups.values()];
  }

  /**
   * LLM-based session-scoped synthesis (SimpleMem §2.2).
   * Fsyn(Osession, Ccontext; f) — merges a cluster of related facts
   * into a single coherent entry.
   */
  private async llmSynthesize(
    cluster: MemoryUnit[],
    ctx: WorkflowContext,
  ): Promise<MemoryUnit> {
    try {
      const llm = ctx.getLLM();
      const embedder = ctx.getEmbeddings();

      const clusterEntries = cluster
        .map((u, i) => `${i + 1}. [${u.type}] ${u.content}`)
        .join("\n");

      const { messages } = loadAndRender("simplemem/synthesis", {
        cluster_size: cluster.length,
        cluster_entries: clusterEntries.substring(0, 2000),
      });

      const resp = await llm.invoke(messages);
      const synthesized = typeof resp.content === "string"
        ? resp.content.trim()
        : cluster.map((u) => u.content).join("; ");

      // Re-embed the synthesized content
      let embedding: number[] = cluster[0].embedding;
      try {
        embedding = await embedder.embedQuery(synthesized.substring(0, 500));
      } catch (embErr) {
        // Improvement #6: structured error logging
        ctx.logger.debug("SemanticSynthesis: re-embedding failed, keeping original", {
          error: (embErr as Error).message,
        });
      }

      return {
        ...cluster[0],
        content: synthesized.substring(0, 1000),
        embedding,
        metadata: {
          ...cluster[0].metadata,
          synthesized: true,
          synthesisMethod: "llm",
          mergedFrom: cluster.map((u) => u.id),
          confidence: Math.max(
            ...cluster.map((u) => (u.metadata.confidence as number) ?? 0.7),
          ),
        },
      };
    } catch (err) {
      // Improvement #6: structured error logging
      ctx.logger.warn("SemanticSynthesis: LLM synthesis failed, using pairwise merge", {
        error: (err as Error).message,
        clusterSize: cluster.length,
      });
      // Fallback to pairwise merge
      return this.pairwiseMerge(cluster);
    }
  }

  /**
   * Original pairwise merge — concatenate content, average embeddings.
   * Used as fallback when LLM is unavailable.
   */
  private pairwiseMerge(cluster: MemoryUnit[]): MemoryUnit {
    const base = { ...cluster[0] };
    for (let i = 1; i < cluster.length; i++) {
      base.content = `${base.content}\n${cluster[i].content}`;
      base.embedding = base.embedding.map(
        (v, idx) => (v + (cluster[i].embedding[idx] ?? 0)) / 2,
      );
    }
    base.metadata = {
      ...base.metadata,
      synthesized: true,
      synthesisMethod: "pairwise",
      mergedFrom: cluster.map((u) => u.id),
      confidence: Math.max(
        ...cluster.map((u) => (u.metadata.confidence as number) ?? 0.7),
      ),
    };
    return base;
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
