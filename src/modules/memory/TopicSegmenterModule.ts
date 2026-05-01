/**
 * TopicSegmenterModule — hybrid B1∩B2 topic boundary detection
 *
 * Extracted from LightMem STM tier. Segments a flat list of memory
 * units into topic-coherent groups using the hybrid boundary detection
 * algorithm from the LightMem paper:
 *
 *  B1: Attention-based local maxima (embedding distance peaks)
 *  B2: Similarity-based threshold drops (cosine < topicSimilarityThreshold)
 *  Boundaries = B1 ∩ B2 (with B2 fallback if intersection is empty)
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: topicSegments (MemoryUnit[][])
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { cosineSimilarity } from "../../utils/similarity.js";

const ConfigSchema = z.object({
  /** B2 cosine threshold for topic boundary detection */
  topicSimilarityThreshold: z.number().min(0).max(1).default(0.6),
  /** Minimum segment size (prevents single-unit segments) */
  minSegmentSize: z.number().default(2),
});

type TopicSegmenterConfig = z.infer<typeof ConfigSchema>;

export class TopicSegmenterModule implements BaseModule<TopicSegmenterConfig> {
  readonly name = "TopicSegmenter";
  readonly version = "0.2.0";
  private config: TopicSegmenterConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<TopicSegmenterConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length <= 1) {
      return {
        data: { topicSegments: units.length > 0 ? [units] : [], memoryUnits: units },
        metrics: { segments: units.length > 0 ? 1 : 0 },
      };
    }

    // Compute pairwise cosine similarities between adjacent units
    const similarities: number[] = [];
    for (let i = 0; i < units.length - 1; i++) {
      if (units[i].embedding.length > 0 && units[i + 1].embedding.length > 0) {
        similarities.push(cosineSimilarity(units[i].embedding, units[i + 1].embedding));
      } else {
        similarities.push(0.5); // Default for missing embeddings
      }
    }

    // B1: Attention-based local maxima (distance peaks = similarity valleys)
    const b1Boundaries = new Set<number>();
    for (let i = 1; i < similarities.length - 1; i++) {
      // Local minimum in similarity = local maximum in distance
      if (similarities[i] < similarities[i - 1] && similarities[i] < similarities[i + 1]) {
        b1Boundaries.add(i + 1); // Boundary is *after* position i
      }
    }

    // B2: Threshold-based drops
    const b2Boundaries = new Set<number>();
    for (let i = 0; i < similarities.length; i++) {
      if (similarities[i] < this.config.topicSimilarityThreshold) {
        b2Boundaries.add(i + 1);
      }
    }

    // Hybrid: B1 ∩ B2 (with B2 fallback if intersection is empty)
    let boundaries: number[];
    const intersection = [...b1Boundaries].filter((b) => b2Boundaries.has(b));

    if (intersection.length > 0) {
      boundaries = intersection.sort((a, b) => a - b);
    } else {
      // Fallback to B2 only
      boundaries = [...b2Boundaries].sort((a, b) => a - b);
    }

    // Build segments from boundary indices
    const segments: MemoryUnit[][] = [];
    let start = 0;
    for (const boundary of boundaries) {
      const segment = units.slice(start, boundary);
      if (segment.length >= this.config.minSegmentSize) {
        segments.push(segment);
      } else if (segments.length > 0) {
        // Merge small segments into the previous one
        segments[segments.length - 1].push(...segment);
      } else {
        segments.push(segment);
      }
      start = boundary;
    }
    // Final segment
    const lastSegment = units.slice(start);
    if (lastSegment.length > 0) {
      if (lastSegment.length < this.config.minSegmentSize && segments.length > 0) {
        segments[segments.length - 1].push(...lastSegment);
      } else {
        segments.push(lastSegment);
      }
    }

    ctx.logger.info(
      `TopicSegmenter: ${segments.length} segments from ${units.length} units ` +
        `(B1=${b1Boundaries.size}, B2=${b2Boundaries.size}, B1∩B2=${intersection.length})`,
    );

    return {
      data: { topicSegments: segments, memoryUnits: units },
      metrics: {
        segments: segments.length,
        b1Boundaries: b1Boundaries.size,
        b2Boundaries: b2Boundaries.size,
        hybridBoundaries: intersection.length,
      },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
