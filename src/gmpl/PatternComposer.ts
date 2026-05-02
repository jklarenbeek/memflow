/**
 * PatternComposer — programmatic multi-pattern workflow generation
 *
 * Composes multiple GMPL patterns into a single WorkflowConfig JSON
 * ready for WorkflowEngine execution. Enables dynamic workflow creation
 * from a PatternComposition schema.
 *
 * Usage:
 *   const workflow = generateWorkflow({
 *     name: 'research',
 *     stages: [
 *       { id: 'analyze', pattern: 'parallel_analysis' },
 *       { id: 'debate', pattern: 'structured_debate' },
 *     ],
 *   });
 *   const engine = new WorkflowEngine(workflow);
 */

import { PatternCompositionSchema } from "./types.js";
import { PatternRegistry } from "./PatternRegistry.js";
import type { WorkflowConfig, WorkflowStage } from "../core/types.js";
import type { z } from "zod";

/** Input type for generateWorkflow — allows omitting fields with Zod defaults */
type PatternCompositionInput = z.input<typeof PatternCompositionSchema>;

/**
 * Generate a WorkflowConfig from a PatternComposition definition.
 *
 * Resolves pattern references from PatternRegistry, wires stages
 * sequentially, and optionally appends an OutcomeMemory tail stage.
 *
 * @param composition - Pattern composition definition
 * @returns Valid WorkflowConfig ready for WorkflowEngine
 * @throws if a referenced pattern is not found in PatternRegistry
 */
export function generateWorkflow(composition: PatternCompositionInput): WorkflowConfig {
  // Validate input
  const validated = PatternCompositionSchema.parse(composition);
  const registry = PatternRegistry.getInstance();

  if (validated.stages.length === 0) {
    throw new Error("PatternComposer: Composition must have at least one stage.");
  }

  const stages: WorkflowStage[] = [];

  for (let i = 0; i < validated.stages.length; i++) {
    const stageDef = validated.stages[i];
    const nextStageId =
      i < validated.stages.length - 1
        ? validated.stages[i + 1].id
        : validated.memory?.twoPhaseEnabled
          ? "_outcome_memory"
          : null;

    if (stageDef.pattern) {
      // Resolve pattern from registry
      const pattern = registry.get(stageDef.pattern);
      if (!pattern) {
        throw new Error(
          `PatternComposer: Pattern "${stageDef.pattern}" not found in PatternRegistry. ` +
          `Available: ${registry.list().join(", ")}`,
        );
      }

      stages.push({
        id: stageDef.id,
        module: "SubWorkflow",
        config: {
          ...stageDef.config,
          _patternId: stageDef.pattern,
        },
        workflowRef: pattern.workflowRef,
        next: nextStageId,
      });
    } else if (stageDef.module) {
      // Direct module reference
      stages.push({
        id: stageDef.id,
        module: stageDef.module,
        config: stageDef.config as Record<string, unknown>,
        next: nextStageId,
      });
    } else {
      throw new Error(
        `PatternComposer: Stage "${stageDef.id}" must specify either 'pattern' or 'module'.`,
      );
    }
  }

  // Append OutcomeMemory if two-phase enabled
  if (validated.memory?.twoPhaseEnabled) {
    stages.push({
      id: "_outcome_memory",
      module: "OutcomeMemory",
      config: {
        twoPhaseEnabled: validated.memory.twoPhaseEnabled,
        pendingTTL: validated.memory.pendingTTL,
        reflectionModel: validated.memory.reflectionModel,
        crossDomainLessons: validated.memory.crossDomainLessons,
      },
      next: null,
    });
  }

  const workflow: WorkflowConfig = {
    name: validated.name,
    version: "1.0",
    description: `Composed workflow: ${validated.stages.map((s) => s.pattern ?? s.module).join(" → ")}`,
    entry: stages[0].id,
    stages,
  };

  if (validated.domain) {
    workflow.globalConfig = {
      ...workflow.globalConfig,
      tenantId: validated.domain,
    };
  }

  return workflow;
}
