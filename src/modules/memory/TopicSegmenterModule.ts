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
import { similarity, type SimilarityFunction } from "../../utils/similarity.js";

const ConfigSchema = z.object({
  /** B2 cosine threshold for topic boundary detection */
  topicSimilarityThreshold: z.number().min(0).max(1).default(0.6),
  /** Minimum segment size (prevents single-unit segments) */
  minSegmentSize: z.number().default(2),
  /** Similarity function to use for boundary detection (Improvement #14) */
  similarityFunction: z.enum(["cosine", "euclidean", "dotProduct"]).default("cosine"),
});

type TopicSegmenterConfig = z.infer<typeof ConfigSchema>;

export class TopicSegmenterModule implements BaseModule<TopicSegmenterConfig> {
  readonly name = "TopicSegmenter";
  readonly version = "0.5.0";
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
    const simFn = this.config.similarityFunction as SimilarityFunction;

    if (units.length <= 1) {
      return {
        data: { topicSegments: units.length > 0 ? [units] : [], memoryUnits: units },
        metrics: { segments: units.length > 0 ? 1 : 0 },
      };
    }

    // Compute pairwise similarities between adjacent units (Improvement #14: configurable)
    const similarities: number[] = [];
    for (let i = 0; i < units.length - 1; i++) {
      if (units[i].embedding.length > 0 && units[i + 1].embedding.length > 0) {
        similarities.push(similarity(units[i].embedding, units[i + 1].embedding, simFn));
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

    // Improvement #7: Set topicLabel on each MemoryUnit from segment analysis
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      // Generate a topic label from the segment's content
      const topicLabel = this.deriveTopicLabel(segment, segIdx);
      for (const unit of segment) {
        unit.topicLabel = topicLabel;
      }
    }

    ctx.logger.info(
      `TopicSegmenter: ${segments.length} segments from ${units.length} units ` +
        `(B1=${b1Boundaries.size}, B2=${b2Boundaries.size}, B1∩B2=${intersection.length}, sim=${simFn})`,
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

  /**
   * Derive a topic label for a segment from its content.
   *
   * Uses lightweight heuristics (most common entities, leading keywords)
   * rather than an LLM call to keep segmentation fast.
   * (Improvement #7: populates topicLabel on MemoryUnit)
   */
  private deriveTopicLabel(segment: MemoryUnit[], segmentIndex: number): string {
    // Collect all entities mentioned across the segment
    const entityCounts = new Map<string, number>();
    for (const unit of segment) {
      for (const entity of unit.metadata.entities ?? []) {
        entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1);
      }
    }

    // If we have entities, use the top 2 as the label
    if (entityCounts.size > 0) {
      const topEntities = [...entityCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name]) => name);
      return topEntities.join(" & ");
    }

    // Fallback: extract leading keywords from the first unit's content
    const firstContent = segment[0]?.content ?? "";
    const words = firstContent
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);

    if (words.length > 0) {
      return words.join(" ");
    }

    return `topic-${segmentIndex + 1}`;
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
