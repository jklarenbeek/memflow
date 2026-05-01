/**
 * EntityProfilerModule — LLM-driven entity profiling (LightRAG §3.1)
 * Reads:  entities, chunks
 * Writes: (side-effect: profiles persisted to graph)
 */
import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({ maxEntities: z.number().default(20) });
type Config = z.infer<typeof ConfigSchema>;
type Entity = { name: string; type: string; description: string };

export class EntityProfilerModule implements BaseModule<Config> {
  readonly name = "EntityProfiler";
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const entities = (input.data.entities ?? []) as Entity[];
    const docs = (input.data.chunks ?? []) as Document[];
    let profiled = 0;

    for (const entity of entities.slice(0, this.config.maxEntities)) {
      const contexts = docs
        .filter((d) => d.pageContent.toLowerCase().includes(entity.name.toLowerCase()))
        .map((d) => d.pageContent.substring(0, 300)).slice(0, 5);
      if (contexts.length === 0) continue;

      try {
        const llm = ctx.getLLM();
        const { messages } = loadAndRender("graph/entity_profiling", {
          entity_name: entity.name, entity_type: entity.type, contexts: contexts.join("\n---\n"),
        });
        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

        await ctx.memgraph.query(
          `MATCH (e:Entity {name: $name}) SET e.profileSummary = $summary, e.keyThemes = $themes`,
          { name: entity.name, summary: parsed.summary ?? "", themes: parsed.key_themes ?? [] },
        );
        profiled++;
      } catch { /* profiling is optional */ }
    }

    ctx.logger.info(`EntityProfiler: Profiled ${profiled}/${entities.length} entities`);
    return { data: { entities }, metrics: { profiled } };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
