/**
 * StructuredIndexModule — multi-view lexical + symbolic indexing
 *
 * Extracted from SimpleMem §2. Enriches each memory unit with three
 * complementary index representations for downstream retrieval:
 *
 *  1. Semantic Layer: dense embedding (already in unit.embedding)
 *  2. Lexical Layer: TF-based keyword extraction for sparse matching
 *  3. Symbolic Layer: structured metadata (type, timestamp, source)
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — enriched with index metadata
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Number of top keywords to extract per unit */
  maxKeywords: z.number().default(10),
  /** Minimum word length for keyword extraction */
  minWordLength: z.number().default(4),
});

type StructuredIndexConfig = z.infer<typeof ConfigSchema>;

export class StructuredIndexModule implements BaseModule<StructuredIndexConfig> {
  readonly name = "StructuredIndex";
  readonly version = "0.5.0";
  private config: StructuredIndexConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<StructuredIndexConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { indexed: 0 } };
    }

    for (const unit of units) {
      // Lexical layer: extract keywords via simple TF analysis
      const words = unit.content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length >= this.config.minWordLength);
      const wordFreq = new Map<string, number>();
      for (const w of words) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
      unit.metadata.lexicalKeywords = [...wordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.config.maxKeywords)
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

    ctx.logger.info(`StructuredIndex: Indexed ${units.length} units`);

    return {
      data: { memoryUnits: units },
      metrics: { indexed: units.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
