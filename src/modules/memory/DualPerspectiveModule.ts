/**
 * DualPerspectiveModule — content + interactional extraction
 *
 * Extracted from StructMem §3.1. Enriches memory units with:
 *  1. Content perspective: temporal references from text
 *  2. Interactional perspective: entities and typed relations
 *
 * Falls back to regex-based NER when LLM is unavailable.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — enriched with entities/temporal
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Use LLM for extraction (falls back to regex) */
  useLLM: z.boolean().default(true),
});

type DualPerspectiveConfig = z.infer<typeof ConfigSchema>;

export class DualPerspectiveModule implements BaseModule<DualPerspectiveConfig> {
  readonly name = "DualPerspective";
  readonly version = "0.5.0";
  private config: DualPerspectiveConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<DualPerspectiveConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const units = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (units.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { enriched: 0 } };
    }

    let enriched = 0;

    for (const unit of units) {
      if (this.config.useLLM) {
        try {
          const llm = ctx.getLLM();
          const { messages } = loadAndRender("structmem/dual_perspective", {
            content: unit.content.substring(0, 600),
          });

          const resp = await llm.invoke(messages);
          const text = typeof resp.content === "string" ? resp.content : "";
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

          unit.metadata.temporal =
            parsed.temporal ?? unit.metadata.temporal ?? new Date().toISOString();
          unit.metadata.entities =
            parsed.entities?.length > 0
              ? parsed.entities
              : this.extractEntitiesFallback(unit.content);
          unit.metadata.eventType = parsed.eventType ?? "fact";

          if (parsed.relations?.length > 0) {
            unit.metadata.interactionalRelations = parsed.relations;
          }
          enriched++;
        } catch {
          this.applyFallback(unit);
        }
      } else {
        this.applyFallback(unit);
      }
    }

    ctx.logger.info(`DualPerspective: Enriched ${enriched}/${units.length} units`);

    return {
      data: { memoryUnits: units },
      metrics: { enriched, total: units.length },
    };
  }

  private applyFallback(unit: MemoryUnit): void {
    unit.metadata.temporal =
      unit.metadata.temporal ?? this.extractTemporalFallback(unit.content);
    unit.metadata.entities =
      unit.metadata.entities ?? this.extractEntitiesFallback(unit.content);
    unit.metadata.eventType = unit.metadata.eventType ?? "fact";
  }

  private extractEntitiesFallback(text: string): string[] {
    const entities: string[] = [];
    const nameMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g);
    if (nameMatch) entities.push(...nameMatch.slice(0, 5));
    return [...new Set(entities)];
  }

  private extractTemporalFallback(text: string): string {
    const isoMatch = text.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?/);
    if (isoMatch) return isoMatch[0];
    const naturalMatch = text.match(
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}/i,
    );
    if (naturalMatch) return new Date(naturalMatch[0]).toISOString();
    return new Date().toISOString();
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
