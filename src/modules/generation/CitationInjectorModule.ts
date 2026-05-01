/**
 * CitationInjectorModule — add inline/footnote citations
 * Reads:  finalAnswer, sources
 * Writes: finalAnswer (with citations)
 */
import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";

const ConfigSchema = z.object({
  style: z.enum(["inline", "footnote"]).default("inline"),
  maxCitations: z.number().default(6),
});
type Config = z.infer<typeof ConfigSchema>;

export class CitationInjectorModule implements BaseModule<Config> {
  readonly name = "CitationInjector";
  readonly version = "0.2.0";
  private config: Config;
  constructor(config: Record<string, unknown> = {}) { this.config = ConfigSchema.parse(config); }

  async process(input: ModuleInput<Config>): Promise<ModuleOutput> {
    let answer = (input.data.finalAnswer as string) ?? "";
    const sources = ((input.data.sources as string[]) ?? ["internal-knowledge"]).slice(0, this.config.maxCitations);

    if (!answer.includes("[")) {
      answer = `${answer}\n\nSources: ${sources.map((s, i) => `[${i + 1}] ${s}`).join(" ")}`;
    }

    return {
      data: { finalAnswer: answer, sources },
      metrics: { citations: sources.length },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
