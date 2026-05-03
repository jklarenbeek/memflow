/**
 * IntentCompilerModule — generate workflow JSON from natural language intent
 *
 * Inspired by MASFactory (2603.06007): compiles a user's natural language
 * intent into a valid MemFlow workflow JSON DAG through a 3-stage pipeline:
 *  1. Role Assignment — suggest agents/roles from RoleRegistry
 *  2. Topology Design — wire stages into a DAG with dependsOn/next
 *  3. Semantic Completion — populate prompt refs, inputMap/outputMap
 *
 * Output is validated against WorkflowConfig Zod schema with
 * error-feedback retry loop.
 *
 * Reads:  query
 * Writes: compiledWorkflow
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput, WorkflowConfig } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { ModuleRegistry } from "../../core/ModuleRegistry.js";
import { loadAndRender } from "../../utils/promptLoader.js";
import { evolutionIntentCompilationsCounter } from "../../server/metrics.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  maxRetries: z.number().default(3),
  /** Available module names for topology design.
   *  §5.5: Defaults to user-facing modules, excluding internal/infrastructure ones. */
  moduleAllowlist: z.array(z.string()).default([
    // Memory
    "SimpleMem", "LightMem", "StructMem",
    // Retrieval
    "LightRAGRetriever",
    // Agents
    "HERAOrchestrator",
    // Generation
    "PriHAFusion", "DualSourceFusion", "AnswerGenerator", "WebSearchAgent",
    // Graph
    "MemgraphGraph",
    // Chunking
    "S2Chunker", "MarkdownSpatialParser", "PDFSpatialParser", "ParentChildChunker",
    // Query
    "QueryTranslator",
    // GMPL Patterns
    "DebateModule", "PeerReviewModule", "RedTeamModule", "DelphiPanelModule",
    "ParallelDispatcher", "MultiTurnClarifier",
    // Evolution
    "SLMDatasetExporter", "Trace2Skill", "SkillInjector", "HarnessEvolver",
    "SkillBasisExtractor", "SkillGapAnalyzer",
  ]),
  /** Available pattern IDs for composition */
  patternAllowlist: z.array(z.string()).optional(),
  outputDir: z.string().default("src/workflows/generated"),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Inline WorkflowConfig validator (subset for validation)
// ---------------------------------------------------------------------------

const WorkflowStageSchema = z.object({
  id: z.string(),
  module: z.string(),
  config: z.record(z.unknown()).default({}),
  dependsOn: z.array(z.string()).optional(),
  next: z.union([z.string(), z.array(z.string()), z.record(z.string()), z.null()]).optional(),
});

const WorkflowConfigSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  entry: z.string(),
  stages: z.array(WorkflowStageSchema).min(1),
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class IntentCompilerModule implements BaseModule<Config> {
  readonly name = "IntentCompiler";
  readonly version = "0.1.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const intent = input.data.query;
    const config = input.config;

    if (!intent) {
      return { data: { compiledWorkflow: undefined }, metrics: { success: false } };
    }

    const availableModules = config.moduleAllowlist
      ?? ModuleRegistry.getInstance().listModules();

    let workflowJson: WorkflowConfig | null = null;
    let lastError = "";

    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
      const raw = await this.generateWorkflow(ctx, intent, availableModules, lastError);

      try {
        // Extract JSON from LLM response
        const jsonStr = this.extractJson(raw);
        workflowJson = WorkflowConfigSchema.parse(JSON.parse(jsonStr)) as unknown as WorkflowConfig;
        break;
      } catch (err) {
        lastError = (err as Error).message;
        ctx.logger.warn(`IntentCompiler: attempt ${attempt + 1} failed: ${lastError}`);
      }
    }

    if (!workflowJson) {
      ctx.logger.warn(`IntentCompiler: All ${config.maxRetries} attempts failed`);
      evolutionIntentCompilationsCounter.inc({ result: "failure" });
      return { data: { compiledWorkflow: undefined }, metrics: { success: false, attempts: config.maxRetries } };
    }

    // §8: Record Prometheus metrics
    evolutionIntentCompilationsCounter.inc({ result: "success" });

    // Optionally write to disk
    if (config.outputDir) {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const filename = `${workflowJson.name.replace(/\s+/g, "-")}.json`;
        const outputPath = path.resolve(config.outputDir, filename);
        await fs.mkdir(path.resolve(config.outputDir), { recursive: true });
        await fs.writeFile(outputPath, JSON.stringify(workflowJson, null, 2));
        ctx.logger.info(`IntentCompiler: Wrote workflow to ${outputPath}`);
      } catch (err) {
        ctx.logger.warn(`IntentCompiler: Failed to write workflow: ${(err as Error).message}`);
      }
    }

    return {
      data: { compiledWorkflow: workflowJson },
      metrics: { success: true, stages: workflowJson.stages.length },
    };
  }

  // -----------------------------------------------------------------------
  // Workflow generation
  // -----------------------------------------------------------------------

  private async generateWorkflow(
    ctx: WorkflowContext,
    intent: string,
    availableModules: string[],
    lastError: string,
  ): Promise<string> {
    const llm = ctx.getLLM();

    try {
      const prompt = loadAndRender("intent-compiler/topology_designer", {
        intent,
        modules: availableModules.join(", "),
        lastError: lastError || "none",
      });

      const resp = await llm.invoke(
        prompt.messages.map((m) => ({ type: m.role as "system" | "user", content: m.content })),
      );
      return typeof resp.content === "string" ? resp.content : "";
    } catch {
      // Fallback: minimal prompt
      const resp = await llm.invoke([
        {
          type: "system" as const,
          content: `You are a workflow compiler. Generate a valid MemFlow workflow JSON from the user's intent.

Available modules: ${availableModules.join(", ")}

Output must be valid JSON matching this schema:
{
  "name": "string",
  "version": "1.0",
  "entry": "stage-id",
  "stages": [{ "id": "string", "module": "ModuleName", "config": {}, "next": "stage-id" | null }]
}

${lastError ? `Previous attempt failed with: ${lastError}\nFix the error.` : ""}`,
        },
        { type: "user" as const, content: intent },
      ]);
      return typeof resp.content === "string" ? resp.content : "";
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractJson(text: string): string {
    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();

    // Try to find raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return jsonMatch[0].trim();

    return text.trim();
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
