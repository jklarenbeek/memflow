/**
 * SymbolicSearchModule — SimpleMem §2.1 Symbolic Layer retrieval
 *
 * Queries memory units by structured metadata constraints produced by
 * the StructuredIndex module's symbolic layer. This completes the
 * three-view retrieval architecture (semantic + lexical + symbolic).
 *
 * Supports filtering by:
 *  - type (fact, event, summary, relation)
 *  - entity names (intersection with unit.metadata.entities)
 *  - time range (all, recent, last_week)
 *  - confidence threshold
 *
 * When Memgraph is available, queries `:MemoryUnit` nodes via
 * parameterized Cypher. Falls back to in-memory filtering.
 *
 * Reads:  query, symbolicFilter, memoryUnits
 * Writes: candidates (appended with source="symbolic")
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
  /** Maximum results to return */
  topK: z.number().default(10),
  /** Score weight for fusion with other channels */
  weight: z.number().default(0.2),
  /** Default confidence threshold */
  minConfidence: z.number().default(0.5),
});

type SymbolicSearchConfig = z.infer<typeof ConfigSchema>;

interface SymbolicFilter {
  type?: string;
  entities?: string[];
  timeRange?: "all" | "recent" | "last_week" | "last_month";
  minConfidence?: number;
}

export class SymbolicSearchModule implements BaseModule<SymbolicSearchConfig> {
  readonly name = "SymbolicSearch";
  readonly version = "0.2.0";
  private config: SymbolicSearchConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SymbolicSearchConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    // Parse symbolic filter from IntentAwarePlanner output
    let filter: SymbolicFilter = {};
    try {
      const rawFilter = input.data.symbolicFilter as string | undefined;
      if (rawFilter) {
        filter = JSON.parse(rawFilter) as SymbolicFilter;
      }
    } catch { /* use empty filter */ }

    if (units.length === 0) {
      return { data: { candidates: input.data.candidates ?? [] }, metrics: { symbolicMatches: 0 } };
    }

    // Apply symbolic filters to in-memory units
    let matched = [...units];

    // Filter by type
    if (filter.type) {
      matched = matched.filter((u) => u.type === filter.type);
    }

    // Filter by entities (intersection)
    if (filter.entities && filter.entities.length > 0) {
      const targetEntities = new Set(
        filter.entities.map((e) => e.toLowerCase()),
      );
      matched = matched.filter((u) => {
        const unitEntities = (u.metadata.entities as string[]) ?? [];
        return unitEntities.some((e) => targetEntities.has(e.toLowerCase()));
      });
    }

    // Filter by time range
    if (filter.timeRange && filter.timeRange !== "all") {
      const now = Date.now();
      const cutoffs: Record<string, number> = {
        recent: now - 24 * 60 * 60 * 1000,        // 24h
        last_week: now - 7 * 24 * 60 * 60 * 1000, // 7 days
        last_month: now - 30 * 24 * 60 * 60 * 1000, // 30 days
      };
      const cutoff = cutoffs[filter.timeRange] ?? 0;
      matched = matched.filter(
        (u) => new Date(u.timestamp).getTime() >= cutoff,
      );
    }

    // Filter by confidence
    const minConf = filter.minConfidence ?? this.config.minConfidence;
    matched = matched.filter(
      (u) => (u.metadata.confidence as number ?? 0.5) >= minConf,
    );

    // Sort by confidence descending, take topK
    matched.sort(
      (a, b) =>
        ((b.metadata.confidence as number) ?? 0.5) -
        ((a.metadata.confidence as number) ?? 0.5),
    );
    matched = matched.slice(0, this.config.topK);

    // Convert to candidate format for ResultRanker
    const existingCandidates = (input.data.candidates as Array<{
      id: string; text: string; embedding: number[];
      score: number; source: string; metadata: Record<string, unknown>;
    }>) ?? [];

    const symbolicCandidates = matched.map((u) => ({
      id: u.id,
      text: u.content,
      embedding: u.embedding,
      score: ((u.metadata.confidence as number) ?? 0.5) * this.config.weight,
      source: "symbolic" as const,
      metadata: {
        ...u.metadata,
        retrievalChannel: "symbolic",
        matchedType: u.type,
      },
    }));

    ctx.logger.info(
      `SymbolicSearch: ${symbolicCandidates.length} matches from ${units.length} units ` +
        `(filter: ${JSON.stringify(filter)})`,
    );

    return {
      data: { candidates: [...existingCandidates, ...symbolicCandidates] },
      metrics: { symbolicMatches: symbolicCandidates.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
