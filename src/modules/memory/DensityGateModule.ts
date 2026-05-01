/**
 * DensityGateModule — semantic density filtering
 *
 * Extracted from SimpleMem paper Eq. 1: Φ_gate(W) → {mk} | |{mk}| ≥ 0.
 * Filters windowed chunks by semantic density — only passes through
 * windows that contain enough novel information to justify extraction.
 *
 * Reads:  windowedChunks (Document[][]), memoryUnits (MemoryUnit[])
 * Writes: filteredChunks (Document[]) — combined text per surviving window
 */

import { z } from "zod";
import { Document } from "@langchain/core/documents";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { loadAndRender } from "../../utils/promptLoader.js";

const ConfigSchema = z.object({
  /** Enable LLM-based density evaluation (falls back to heuristic) */
  useLLM: z.boolean().default(true),
  /** Minimum distinct fact count to pass the gate */
  minFactCount: z.number().default(2),
});

type DensityGateConfig = z.infer<typeof ConfigSchema>;

export class DensityGateModule implements BaseModule<DensityGateConfig> {
  readonly name = "DensityGate";
  readonly version = "0.2.0";
  private config: DensityGateConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<DensityGateConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const windowedChunks = (input.data.windowedChunks ?? []) as Document[][];
    const existing = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (windowedChunks.length === 0) {
      return { data: { filteredChunks: [] }, metrics: { passed: 0, filtered: 0 } };
    }

    const passed: Document[] = [];
    let filtered = 0;

    for (const window of windowedChunks) {
      const combinedText = window.map((c) => c.pageContent ?? "").join("\n---\n");

      const isDense = this.config.useLLM
        ? await this.llmDensityGate(combinedText, existing, ctx)
        : this.heuristicDensityGate(combinedText);

      if (isDense) {
        passed.push(
          new Document({
            pageContent: combinedText,
            metadata: { ...window[0]?.metadata, windowSize: window.length },
          }),
        );
      } else {
        filtered++;
      }
    }

    ctx.logger.info(
      `DensityGate: ${passed.length} passed, ${filtered} filtered out of ${windowedChunks.length} windows`,
    );

    return {
      data: { filteredChunks: passed },
      metrics: { passed: passed.length, filtered },
    };
  }

  private async llmDensityGate(
    text: string,
    existing: MemoryUnit[],
    ctx: WorkflowContext,
  ): Promise<boolean> {
    try {
      const llm = ctx.getLLM();
      const existingSummary = existing
        .slice(-5)
        .map((u) => u.content.substring(0, 100))
        .join("; ");

      const { messages } = loadAndRender("simplemem/density_gating", {
        window_text: text.substring(0, 1500),
        existing_summary: existingSummary || "none",
      });

      const resp = await llm.invoke(messages);
      const content = typeof resp.content === "string" ? resp.content : "";
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      return (parsed.distinct_facts ?? 0) >= this.config.minFactCount;
    } catch {
      return this.heuristicDensityGate(text);
    }
  }

  private heuristicDensityGate(text: string): boolean {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 15);
    return sentences.length >= this.config.minFactCount;
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
