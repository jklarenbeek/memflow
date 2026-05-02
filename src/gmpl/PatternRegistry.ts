/**
 * PatternRegistry — central registry of composable workflow patterns
 *
 * Modeled after core `ModuleRegistry`. Patterns are self-contained
 * sub-workflow templates with typed input/output contracts and Zod
 * config schemas. HERA can query this registry to discover, select,
 * and compose patterns at the meta-orchestration level.
 *
 * Lifecycle:
 *  1. Built-in patterns are auto-registered on first access
 *  2. Custom patterns can be registered at runtime via `register()`
 *  3. Patterns are retrieved by ID for composition or direct execution
 */

import { z, type ZodSchema } from "zod";
import type { WorkflowPattern } from "./types.js";
import { PatternValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Built-in pattern definitions (auto-registered)
// ---------------------------------------------------------------------------

function createBuiltinPatterns(): WorkflowPattern[] {
  return [
    {
      id: "structured_debate",
      version: "0.5.1",
      description:
        "Structured opposing-view debate with rounds, evidence citations, " +
        "and consensus judgment. Inspired by TradingAgents bull/bear debates.",
      workflowRef: "src/workflows/sub/patterns/structured-debate.json",
      configSchema: z.object({
        roles: z.array(
          z.object({
            id: z.string(),
            persona: z.string(),
            promptPack: z.string().optional(),
          }),
        ),
        maxRounds: z.number().min(1).max(10).default(3),
        termination: z.object({
          type: z.enum(["max_rounds", "consensus_threshold", "judge_decision"]),
          judgeRole: z.string().optional(),
          consensusThreshold: z.number().min(0).max(1).optional(),
        }).default({ type: "max_rounds" }),
        evidenceRetrieval: z.enum(["hybrid", "vector", "graph", "none"]).default("none"),
        historyInjection: z.boolean().default(true),
      }),
      requiredRoles: ["opposing_researcher", "decision_maker"],
      inputContract: z.object({
        query: z.string(),
      }),
      outputContract: z.object({
        debateState: z.unknown(),
        consensusReport: z.unknown(),
        finalAnswer: z.string().optional(),
      }),
      observabilityEvents: [
        "debate:round_start",
        "debate:position",
        "debate:consensus_reached",
      ],
    },
    {
      id: "clarification_pipeline",
      version: "0.5.1",
      description:
        "Multi-turn clarification → dual-source retrieval → reconciled generation. " +
        "Inspired by PriHA PHC-O query optimizer + DRAG pattern.",
      workflowRef: "src/workflows/sub/patterns/clarification-pipeline.json",
      configSchema: z.object({
        clarification: z.object({
          maxTurns: z.number().min(1).max(10).default(5),
          complexityGate: z.boolean().default(true),
          intentSchema: z.string().optional(),
        }).default({}),
        retrieval: z.object({
          localSource: z.object({
            type: z.string().default("vector_kg"),
            collection: z.string().optional(),
          }).default({}),
          dynamicSource: z.object({
            type: z.string().default("web_agent"),
            safelist: z.array(z.string()).default([]),
          }).default({}),
          fusionStrategy: z.enum(["authority_weighted", "equal", "local_only", "web_only"]).default("authority_weighted"),
        }).default({}),
        generation: z.object({
          hallucinationCheck: z.boolean().default(true),
          citationRequired: z.boolean().default(true),
          sourceAuthorityScoring: z.boolean().default(true),
        }).default({}),
      }),
      requiredRoles: ["clarifier"],
      inputContract: z.object({
        query: z.string(),
      }),
      outputContract: z.object({
        clarificationState: z.unknown(),
        finalAnswer: z.string().optional(),
        sources: z.array(z.string()).optional(),
      }),
      observabilityEvents: [
        "clarification:question",
        "clarification:response",
        "clarification:intent_resolved",
      ],
    },
    {
      id: "parallel_analysis",
      version: "0.5.1",
      description:
        "Dispatch query to N parallel analyst agents, collect structured reports, " +
        "and merge via configured strategy. Inspired by TradingAgents analyst pool.",
      workflowRef: "src/workflows/sub/patterns/parallel-analysis.json",
      configSchema: z.object({
        analysts: z.array(
          z.object({
            id: z.string(),
            role: z.string().default("domain_analyst"),
            promptPack: z.string().optional(),
          }),
        ),
        mergeStrategy: z.enum(["ranked_synthesis", "weighted_average", "majority_vote"]).default("ranked_synthesis"),
        timeout: z.string().default("30s"),
      }),
      requiredRoles: ["domain_analyst", "synthesizer"],
      inputContract: z.object({
        query: z.string(),
      }),
      outputContract: z.object({
        analystReports: z.array(z.unknown()),
        mergedAnalysis: z.unknown(),
        finalAnswer: z.string().optional(),
      }),
      observabilityEvents: [
        "analysis:dispatched",
        "analysis:report_received",
        "analysis:merged",
      ],
    },
    {
      id: "peer_review",
      version: "0.5.1",
      description:
        "Iterative peer review cycle: submit draft → N reviewers provide feedback → " +
        "author revises → repeat until accepted or max cycles reached.",
      workflowRef: "src/workflows/sub/patterns/peer-review.json",
      configSchema: z.object({
        reviewers: z.array(
          z.object({
            id: z.string(),
            persona: z.string(),
            promptPack: z.string().optional(),
          }),
        ).min(1),
        maxCycles: z.number().min(1).max(10).default(3),
        acceptanceThreshold: z.number().min(0).max(1).default(0.7),
        revisionModel: z.string().optional(),
      }),
      requiredRoles: ["critic"],
      inputContract: z.object({
        query: z.string(),
      }),
      outputContract: z.object({
        peerReviewState: z.unknown(),
        finalAnswer: z.string().optional(),
      }),
      observabilityEvents: [
        "review:cycle_start",
        "review:feedback_received",
        "review:draft_revised",
        "review:accepted",
      ],
    },
    {
      id: "red_team",
      version: "0.5.1",
      description:
        "Adversarial stress-testing: red team attacks (freeform LLM, seeded by strategy) → " +
        "blue team defends → judge evaluates resilience. Repeats until threshold met.",
      workflowRef: "src/workflows/sub/patterns/red-team.json",
      configSchema: z.object({
        attackStrategies: z.array(z.string()).default(["adversarial_reframing", "edge_case_injection", "assumption_challenge"]),
        redTeam: z.array(z.object({ id: z.string(), persona: z.string() })).min(1),
        blueTeam: z.array(z.object({ id: z.string(), persona: z.string() })).min(1),
        maxRounds: z.number().min(1).max(10).default(3),
        resilienceThreshold: z.number().min(0).max(1).default(0.7),
      }),
      requiredRoles: ["opposing_researcher", "critic"],
      inputContract: z.object({
        query: z.string(),
      }),
      outputContract: z.object({
        redTeamState: z.unknown(),
        finalAnswer: z.string().optional(),
      }),
      observabilityEvents: [
        "redteam:round_start",
        "redteam:attack",
        "redteam:defense",
        "redteam:resilience_evaluated",
      ],
    },
    {
      id: "delphi_panel",
      version: "0.5.1",
      description:
        "Delphi expert panel: anonymous polling → statistical aggregation → " +
        "share results → re-poll → converge. Supports pluggable convergence metrics.",
      workflowRef: "src/workflows/sub/patterns/delphi-panel.json",
      configSchema: z.object({
        panelSize: z.number().min(2).max(20).default(5),
        maxRounds: z.number().min(1).max(10).default(3),
        anonymize: z.boolean().default(true),
        convergenceMetric: z.string().default("std_dev"),
        convergenceThreshold: z.number().min(0).max(1).default(0.2),
        panelists: z.array(z.object({ id: z.string(), persona: z.string(), promptPack: z.string().optional() })).optional(),
      }),
      requiredRoles: ["domain_analyst"],
      inputContract: z.object({
        query: z.string(),
      }),
      outputContract: z.object({
        delphiPanelState: z.unknown(),
        finalAnswer: z.string().optional(),
      }),
      observabilityEvents: [
        "delphi:poll_start",
        "delphi:response_received",
        "delphi:aggregated",
        "delphi:converged",
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class PatternRegistry {
  private static instance: PatternRegistry;

  private readonly patterns = new Map<string, WorkflowPattern>();
  private builtinsLoaded = false;

  private constructor() {}

  static getInstance(): PatternRegistry {
    if (!PatternRegistry.instance) {
      PatternRegistry.instance = new PatternRegistry();
    }
    return PatternRegistry.instance;
  }

  /** Reset the singleton (useful for testing) */
  static reset(): void {
    PatternRegistry.instance = undefined as unknown as PatternRegistry;
  }

  // -----------------------------------------------------------------------
  // Auto-load builtins
  // -----------------------------------------------------------------------

  private ensureBuiltins(): void {
    if (this.builtinsLoaded) return;
    for (const pattern of createBuiltinPatterns()) {
      if (!this.patterns.has(pattern.id)) {
        this.patterns.set(pattern.id, pattern);
      }
    }
    this.builtinsLoaded = true;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a workflow pattern.
   *
   * @throws if a pattern with the same ID is already registered
   */
  register(pattern: WorkflowPattern): void {
    this.ensureBuiltins();

    if (this.patterns.has(pattern.id)) {
      throw new PatternValidationError(
        pattern.id,
        "id",
        `Pattern "${pattern.id}" is already registered. Use a unique ID or call remove() first.`,
      );
    }

    // Validate that schemas are actual Zod schemas
    this.validateSchemas(pattern);
    this.patterns.set(pattern.id, pattern);
  }

  // -----------------------------------------------------------------------
  // Retrieval
  // -----------------------------------------------------------------------

  /** Get a pattern by ID, or undefined if not found */
  get(id: string): WorkflowPattern | undefined {
    this.ensureBuiltins();
    return this.patterns.get(id);
  }

  /** Check if a pattern is registered */
  has(id: string): boolean {
    this.ensureBuiltins();
    return this.patterns.has(id);
  }

  /** List all registered pattern IDs */
  list(): string[] {
    this.ensureBuiltins();
    return [...this.patterns.keys()];
  }

  /** Get all registered patterns */
  getAll(): WorkflowPattern[] {
    this.ensureBuiltins();
    return [...this.patterns.values()];
  }

  /** Remove a pattern by ID */
  remove(id: string): boolean {
    this.ensureBuiltins();
    return this.patterns.delete(id);
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  private validateSchemas(pattern: WorkflowPattern): void {
    const schemaFields: Array<keyof WorkflowPattern> = [
      "configSchema",
      "inputContract",
      "outputContract",
    ];

    for (const field of schemaFields) {
      const schema = pattern[field] as ZodSchema;
      if (!schema || typeof schema.parse !== "function") {
        throw new PatternValidationError(
          pattern.id,
          field as string,
          "Must be a Zod schema with a parse() method.",
        );
      }
    }
  }
}
