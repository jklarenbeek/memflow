/**
 * SubWorkflowModule — execute a child workflow as a single stage
 *
 * Enables workflows-within-workflows by loading a child WorkflowConfig
 * (inline or from file) and executing it within the parent's shared
 * WorkflowContext. Data mapping between parent and child is controlled
 * by `inputMap` and `outputMap` on the stage definition.
 *
 * Features:
 *  - Shares parent WorkflowContext (LLM, Memgraph, StateStore, Logger)
 *  - Explicit data scoping via inputMap/outputMap
 *  - Recursion depth guard (default max 5)
 *  - File reference or inline workflow definition
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  WorkflowConfig,
  WorkflowData,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";
import { WorkflowEngine } from "../../core/WorkflowEngine.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Inline workflow definition */
  workflow: z.any().optional(),
  /** Path to workflow JSON file (relative to project root or absolute) */
  workflowRef: z.string().optional(),
  /** Map parent data keys → child input keys */
  inputMap: z.record(z.string()).optional(),
  /** Map child output keys → parent data keys */
  outputMap: z.record(z.string()).optional(),
  /** Maximum recursion depth for nested sub-workflows */
  maxDepth: z.number().default(5),
});

type SubWorkflowConfig = z.infer<typeof ConfigSchema>;

// Track recursion depth via a simple global counter per execution chain
let currentDepth = 0;

export class SubWorkflowModule implements BaseModule<SubWorkflowConfig> {
  readonly name = "SubWorkflow";
  readonly version = "0.2.0";
  private config: SubWorkflowConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SubWorkflowConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;

    // Merge stage-level config with constructor config
    const stageConfig = {
      ...this.config,
      ...input.config,
    };

    // Recursion guard
    if (currentDepth >= (stageConfig.maxDepth ?? 5)) {
      throw new Error(
        `SubWorkflow recursion depth exceeded (max ${stageConfig.maxDepth}). ` +
          `Check for circular workflow references.`,
      );
    }

    // Load workflow definition
    const workflowConfig = await this.loadWorkflow(stageConfig);

    // Map parent data → child input
    const childInput = applyInputMap(input.data, stageConfig.inputMap);

    // Execute child workflow with shared context
    currentDepth++;
    try {
      const childEngine = new WorkflowEngine(workflowConfig);
      await childEngine.initializeWithContext(ctx);

      const childState = await childEngine.run(childInput);

      // Map child output → parent data
      const mappedOutput = applyOutputMap(
        childState.data,
        stageConfig.outputMap,
      );

      return {
        data: mappedOutput,
        metrics: {
          subWorkflow: workflowConfig.name,
          childStages: workflowConfig.stages.length,
          childIterations: childState.iteration + 1,
          childErrors: childState.errors.length,
        },
      };
    } finally {
      currentDepth--;
    }
  }

  // -----------------------------------------------------------------------
  // Workflow loading
  // -----------------------------------------------------------------------

  private async loadWorkflow(
    config: SubWorkflowConfig,
  ): Promise<WorkflowConfig> {
    // Inline workflow takes priority
    if (config.workflow) {
      return config.workflow as WorkflowConfig;
    }

    // Load from file reference
    if (config.workflowRef) {
      const refPath = this.resolveWorkflowPath(config.workflowRef);
      const raw = fs.readFileSync(refPath, "utf-8");
      return JSON.parse(raw) as WorkflowConfig;
    }

    throw new Error(
      "SubWorkflow requires either 'workflow' (inline) or 'workflowRef' (file path)",
    );
  }

  private resolveWorkflowPath(ref: string): string {
    // Absolute path
    if (path.isAbsolute(ref)) return ref;

    // Relative to project root (find it from this file's location)
    const thisFile =
      typeof __filename !== "undefined"
        ? __filename
        : fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(thisFile), "..", "..");
    return path.join(projectRoot, ref);
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data mapping helpers
// ---------------------------------------------------------------------------

function applyInputMap(
  data: WorkflowData,
  map?: Record<string, string>,
): Record<string, unknown> {
  if (!map) return { ...data };

  const mapped: Record<string, unknown> = {};
  for (const [parentKey, childKey] of Object.entries(map)) {
    if (data[parentKey] !== undefined) {
      mapped[childKey] = data[parentKey];
    }
  }
  return mapped;
}

function applyOutputMap(
  data: WorkflowData,
  map?: Record<string, string>,
): Partial<WorkflowData> {
  if (!map) return { ...data };

  const mapped: Partial<WorkflowData> = {};
  for (const [childKey, parentKey] of Object.entries(map)) {
    if (data[childKey] !== undefined) {
      (mapped as Record<string, unknown>)[parentKey] = data[childKey];
    }
  }
  return mapped;
}
