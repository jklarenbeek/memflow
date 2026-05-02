/**
 * EntityExtractorModule — LLM-driven entity & relationship extraction (LightRAG §3.1)
 * Reads:  chunks
 * Writes: entities, relationships
 */
import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({ maxChunks: z.number().default(50) });
type Config = z.infer<typeof ConfigSchema>;

export class EntityExtractorModule implements BaseModule<Config> {
  readonly name = "EntityExtractor";
  readonly version = "0.5.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const docs = (input.data.chunks ?? input.data.documents ?? []) as Document[];
    const chunksToProcess = docs.slice(0, this.config.maxChunks);
    const allEntities: Array<{ name: string; type: string; description: string }> = [];
    const allRelationships: Array<{ source: string; target: string; type: string; description: string; keywords: string[] }> = [];

    for (const doc of chunksToProcess) {
      try {
        const llm = ctx.getLLM();
        const { messages } = loadAndRender("graph/entity_extraction", { chunk_text: doc.pageContent.substring(0, 2000) });
        const resp = await llm.invoke(messages);
        const text = typeof resp.content === "string" ? resp.content : "";
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
        allEntities.push(...(parsed.entities ?? []));
        allRelationships.push(...(parsed.relationships ?? []).map((r: any) => ({
          source: r.source ?? "", target: r.target ?? "", type: r.type ?? "RELATES_TO",
          description: r.description ?? "", keywords: (r.keywords ?? []) as string[],
        })));
      } catch (err) { ctx.logger.debug(`EntityExtractor: failed for chunk: ${(err as Error).message}`); }
    }

    ctx.logger.info(`EntityExtractor: ${allEntities.length} entities, ${allRelationships.length} relationships`);
    return { data: { entities: allEntities, relationships: allRelationships, chunks: docs }, metrics: { entities: allEntities.length, relationships: allRelationships.length } };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
