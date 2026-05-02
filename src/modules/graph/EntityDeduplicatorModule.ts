/**
 * EntityDeduplicatorModule — merge equivalent entity references
 * Reads:  entities
 * Writes: entities (deduplicated)
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  useLLM: z.boolean().default(true),
  /** Query existing Memgraph entities for incremental dedup (LightRAG no-rebuild) */
  checkExistingGraph: z.boolean().default(true),
});
type Config = z.infer<typeof ConfigSchema>;

type Entity = { name: string; type: string; description: string };

export class EntityDeduplicatorModule implements BaseModule<Config> {
  readonly name = "EntityDeduplicator";
  readonly version = "0.5.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const entities = (input.data.entities ?? []) as Entity[];
    if (entities.length <= 1 && !this.config.checkExistingGraph) {
      return { data: { entities }, metrics: { deduplicated: 0 } };
    }

    // Fetch existing entities from Memgraph for incremental dedup
    let existingEntities: Entity[] = [];
    if (this.config.checkExistingGraph) {
      try {
        const candidateNames = entities.map((e) => e.name.toLowerCase());
        const existing = await ctx.memgraph.query<{ name: string; type: string; description: string }>(
          `MATCH (e:Entity) WHERE toLower(e.name) IN $candidateNames
           RETURN e.name AS name, e.type AS type, e.description AS description`,
          { candidateNames },
        );
        existingEntities = existing.map((e) => ({
          name: e.name,
          type: e.type ?? "unknown",
          description: e.description ?? "",
        }));
        ctx.logger.debug(`EntityDeduplicator: found ${existingEntities.length} existing entities in graph`);
      } catch {
        ctx.logger.debug("EntityDeduplicator: Memgraph lookup failed, proceeding with batch-only dedup");
      }
    }

    // Combine new + existing for unified deduplication
    const allEntities = [...existingEntities, ...entities];
    const uniqueNames = [...new Set(allEntities.map((e) => e.name))];
    if (uniqueNames.length <= 1) return { data: { entities }, metrics: { deduplicated: 0 } };

    let result: Entity[];
    if (this.config.useLLM) {
      try {
        const llm = ctx.getLLM();
        const { messages } = loadAndRender("graph/deduplication", { entity_list: uniqueNames.join(", ") });
        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
        const groups = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as string[][];

        const canonicalMap = new Map<string, string>();
        for (const group of groups) {
          if (group.length > 0) { const canonical = group[0]; for (const name of group) canonicalMap.set(name, canonical); }
        }

        const seen = new Set<string>();
        result = [];
        for (const entity of allEntities) {
          const canonical = canonicalMap.get(entity.name) ?? entity.name;
          if (!seen.has(canonical)) { seen.add(canonical); result.push({ ...entity, name: canonical }); }
        }
      } catch {
        result = this.simpleDedupe(allEntities);
      }
    } else {
      result = this.simpleDedupe(allEntities);
    }

    ctx.logger.info(`EntityDeduplicator: ${entities.length} → ${result.length}`);
    return { data: { entities: result }, metrics: { before: entities.length, after: result.length } };
  }

  private simpleDedupe(entities: Entity[]): Entity[] {
    const seen = new Map<string, Entity>();
    for (const e of entities) { const key = e.name.toLowerCase(); if (!seen.has(key)) seen.set(key, e); }
    return [...seen.values()];
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
