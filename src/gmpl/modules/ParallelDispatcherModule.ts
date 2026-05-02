/**
 * ParallelDispatcherModule — parallel analyst dispatch (Pattern C)
 *
 * Dispatches a query to N parallel analyst agents, collects structured
 * reports, and merges them using a configurable strategy.
 *
 * Reads:  query
 * Writes: analystReports, mergedAnalysis, finalAnswer
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { AnalystReportSchema, MergedAnalysisSchema, type AnalystReport, type MergedAnalysis } from "../types.js";

const AnalystConfigSchema = z.object({
  id: z.string(),
  role: z.string().default("domain_analyst"),
  promptPack: z.string().optional(),
});

const ConfigSchema = z.object({
  analysts: z.array(AnalystConfigSchema).min(1),
  mergeStrategy: z.enum(["ranked_synthesis", "weighted_average", "majority_vote"]).default("ranked_synthesis"),
  timeout: z.string().default("30s"),
});
type Config = z.infer<typeof ConfigSchema>;
type AnalystConfig = z.infer<typeof AnalystConfigSchema>;

export class ParallelDispatcherModule implements BaseModule<Config> {
  readonly name = "ParallelDispatcher";
  readonly version = "0.5.1";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const inputConfig = Object.keys(input.config).length > 0 ? ConfigSchema.parse(input.config) : {};
    const mergedConfig = { ...this.config, ...inputConfig };
    const query = (input.data.query as string) ?? "";

    ctx.logger.info(`ParallelDispatcher: Dispatching to ${mergedConfig.analysts.length} analysts`);

    // Parse timeout
    const timeoutMs = this.parseTimeout(mergedConfig.timeout);

    // Dispatch all analysts in parallel with timeout
    const reportPromises = mergedConfig.analysts.map((analyst) =>
      this.runAnalyst(ctx, query, analyst, timeoutMs),
    );

    const results = await Promise.allSettled(reportPromises);

    const reports: AnalystReport[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        reports.push(result.value);
      } else {
        ctx.logger.warn(`ParallelDispatcher: Analyst ${mergedConfig.analysts[i].id} failed: ${result.reason}`);
      }
    }

    if (reports.length === 0) {
      return {
        data: { analystReports: [], mergedAnalysis: null },
        metrics: { dispatched: mergedConfig.analysts.length, received: 0 },
      };
    }

    // Merge reports
    const merged = await this.mergeReports(ctx, reports, mergedConfig.mergeStrategy);

    ctx.logger.info(`ParallelDispatcher: Merged ${reports.length} reports via ${mergedConfig.mergeStrategy}`);

    return {
      data: {
        analystReports: reports,
        mergedAnalysis: merged,
        finalAnswer: merged.synthesis,
      },
      metrics: {
        dispatched: mergedConfig.analysts.length,
        received: reports.length,
        averageConfidence: merged.averageConfidence,
        mergeStrategy: mergedConfig.mergeStrategy,
      },
    };
  }

  private async runAnalyst(ctx: WorkflowContext, query: string, analyst: AnalystConfig, timeoutMs: number): Promise<AnalystReport> {
    const llm = ctx.getLLM();

    const prompt = [
      { type: "system" as const, content: `You are analyst "${analyst.id}" with role "${analyst.role}". Produce a structured analysis. Respond with JSON: {"analysis": "...", "confidence": 0.0-1.0, "sources": ["..."], "recommendations": ["..."]}` },
      { type: "user" as const, content: `Analyze: ${query}` },
    ];

    const result = await Promise.race([
      llm.invoke(prompt),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Analyst timeout")), timeoutMs)),
    ]);

    const text = typeof result.content === "string" ? result.content : "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;

    return AnalystReportSchema.parse({
      analystId: analyst.id,
      analysis: (parsed.analysis as string) ?? "No analysis produced",
      confidence: (parsed.confidence as number) ?? 0.5,
      sources: (parsed.sources as string[]) ?? [],
      recommendations: (parsed.recommendations as string[]) ?? [],
    });
  }

  private async mergeReports(ctx: WorkflowContext, reports: AnalystReport[], strategy: string): Promise<MergedAnalysis> {
    const avgConfidence = reports.reduce((s, r) => s + r.confidence, 0) / reports.length;
    const allRecs = [...new Set(reports.flatMap((r) => r.recommendations))];

    if (strategy === "ranked_synthesis") {
      const llm = ctx.getLLM();
      const reportSummary = reports
        .sort((a, b) => b.confidence - a.confidence)
        .map((r) => `[${r.analystId}] (conf: ${r.confidence}): ${r.analysis.substring(0, 500)}`)
        .join("\n\n");

      try {
        const resp = await llm.invoke([
          { type: "system" as const, content: "Synthesize these analyst reports into a unified analysis. Respond with a clear synthesis." },
          { type: "user" as const, content: reportSummary },
        ]);
        const synthesis = typeof resp.content === "string" ? resp.content : "Synthesis failed";
        return MergedAnalysisSchema.parse({ synthesis, reportCount: reports.length, mergeStrategy: strategy, averageConfidence: avgConfidence, recommendations: allRecs });
      } catch {
        // Fallback: concatenate
      }
    }

    // Fallback for all strategies
    const synthesis = reports.map((r) => `[${r.analystId}]: ${r.analysis}`).join("\n\n");
    return MergedAnalysisSchema.parse({ synthesis, reportCount: reports.length, mergeStrategy: strategy, averageConfidence: avgConfidence, recommendations: allRecs });
  }

  private parseTimeout(timeout: string): number {
    const match = timeout.match(/^(\d+)(s|ms|m)$/);
    if (!match) return 30000;
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "ms": return value;
      case "s": return value * 1000;
      case "m": return value * 60000;
      default: return 30000;
    }
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return true; }
}
