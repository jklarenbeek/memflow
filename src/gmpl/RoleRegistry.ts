/**
 * RoleRegistry — library of reusable, domain-agnostic agent roles
 *
 * Patterns draw agents from this registry. Roles define the persona,
 * capabilities, tool declarations, and typed contracts for each agent.
 *
 * Supports role extension: a domain-specific role can extend a base role
 * (e.g., `trading_fundamentals_analyst` extends `domain_analyst`) by
 * inheriting defaults and overriding specific fields.
 */

import { z, type ZodSchema } from "zod";
import type { AgentRole } from "./types.js";

// ---------------------------------------------------------------------------
// Built-in core roles
// ---------------------------------------------------------------------------

/** Permissive passthrough schema — used as default for roles without strict contracts */
const AnyObjectSchema = z.record(z.unknown());

function createBuiltinRoles(): AgentRole[] {
  return [
    {
      id: "domain_analyst",
      description: "Gathers and structures domain data into a comprehensive analysis report.",
      persona: "domain_analyst",
      promptPack: "gmpl/analysis/analyst",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ analysis: z.string(), confidence: z.number(), sources: z.array(z.string()) }),
      requiredModules: ["EntityExtractor"],
    },
    {
      id: "opposing_researcher",
      description: "Argues one side of a debate with evidence-backed positions.",
      persona: "opposing_researcher",
      promptPack: "gmpl/debate/position",
      inputSchema: z.object({ query: z.string(), stance: z.string() }),
      outputSchema: z.object({ position: z.string(), evidence: z.array(z.string()), confidence: z.number() }),
      requiredModules: ["VectorSearch", "CitationInjector"],
    },
    {
      id: "synthesizer",
      description: "Aggregates multiple reports or positions into a coherent unified view.",
      persona: "synthesizer",
      inputSchema: z.object({ reports: z.array(z.unknown()) }),
      outputSchema: z.object({ synthesis: z.string(), confidence: z.number() }),
      requiredModules: ["FinalSynthesizer"],
    },
    {
      id: "risk_assessor",
      description: "Evaluates downsides, volatility, and risk factors of a proposal.",
      persona: "risk_assessor",
      inputSchema: z.object({ proposal: z.string() }),
      outputSchema: z.object({ risks: z.array(z.string()), riskScore: z.number() }),
      requiredModules: [],
    },
    {
      id: "decision_maker",
      description: "Produces a final decision or recommendation with structured rationale.",
      persona: "decision_maker",
      inputSchema: z.object({ options: z.array(z.unknown()) }),
      outputSchema: z.object({ decision: z.string(), rationale: z.string(), confidence: z.number() }),
      requiredModules: ["OutcomeLearner"],
    },
    {
      id: "critic",
      description: "Challenges assumptions and identifies weaknesses in arguments.",
      persona: "critic",
      inputSchema: z.object({ content: z.string() }),
      outputSchema: z.object({ critique: z.string(), issues: z.array(z.string()) }),
      requiredModules: ["Contradiction"],
    },
    {
      id: "clarifier",
      description: "Conducts multi-turn dialogue to disambiguate fuzzy user intent.",
      persona: "clarifier",
      promptPack: "gmpl/clarification/question",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ questions: z.array(z.string()), intentResolved: z.boolean() }),
      requiredModules: ["MultiTurnClarifier"],
    },
    {
      id: "outcome_evaluator",
      description: "Resolves pending decisions with real-world feedback and generates reflections.",
      persona: "outcome_evaluator",
      promptPack: "gmpl/outcome/reflection",
      inputSchema: z.object({ pendingId: z.string(), outcomeData: z.unknown() }),
      outputSchema: z.object({ reflection: z.string(), lessons: z.array(z.string()) }),
      requiredModules: ["OutcomeMemory"],
    },
  ];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class RoleRegistry {
  private static instance: RoleRegistry;

  private readonly roles = new Map<string, AgentRole>();
  private builtinsLoaded = false;

  private constructor() {}

  static getInstance(): RoleRegistry {
    if (!RoleRegistry.instance) {
      RoleRegistry.instance = new RoleRegistry();
    }
    return RoleRegistry.instance;
  }

  /** Reset the singleton (useful for testing) */
  static reset(): void {
    RoleRegistry.instance = undefined as unknown as RoleRegistry;
  }

  // -----------------------------------------------------------------------
  // Auto-load builtins
  // -----------------------------------------------------------------------

  private ensureBuiltins(): void {
    if (this.builtinsLoaded) return;
    for (const role of createBuiltinRoles()) {
      if (!this.roles.has(role.id)) {
        this.roles.set(role.id, role);
      }
    }
    this.builtinsLoaded = true;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a new role.
   *
   * @throws if a role with the same ID is already registered
   */
  register(role: AgentRole): void {
    this.ensureBuiltins();

    if (this.roles.has(role.id)) {
      throw new Error(
        `RoleRegistry: Role "${role.id}" is already registered. ` +
          `Use a unique ID or call remove() first.`,
      );
    }

    this.roles.set(role.id, role);
  }

  /**
   * Extend a base role with domain-specific overrides.
   *
   * Creates a new role that inherits all properties from the base role,
   * with specified overrides applied. The new role's `base` field is set
   * to the base role's ID.
   *
   * @param newId - Unique ID for the new extended role
   * @param baseId - ID of the base role to extend
   * @param overrides - Fields to override from the base role
   * @returns The newly created role
   * @throws if the base role doesn't exist or the new ID is taken
   */
  extend(
    newId: string,
    baseId: string,
    overrides: Partial<Omit<AgentRole, "id" | "base">>,
  ): AgentRole {
    this.ensureBuiltins();

    const base = this.roles.get(baseId);
    if (!base) {
      throw new Error(
        `RoleRegistry: Cannot extend — base role "${baseId}" not found. ` +
          `Available: ${this.list().join(", ")}`,
      );
    }

    const extended: AgentRole = {
      ...base,
      ...overrides,
      id: newId,
      base: baseId,
      requiredModules: overrides.requiredModules ?? [...base.requiredModules],
    };

    this.register(extended);
    return extended;
  }

  // -----------------------------------------------------------------------
  // Retrieval
  // -----------------------------------------------------------------------

  /** Get a role by ID, or undefined if not found */
  get(id: string): AgentRole | undefined {
    this.ensureBuiltins();
    return this.roles.get(id);
  }

  /** Check if a role is registered */
  has(id: string): boolean {
    this.ensureBuiltins();
    return this.roles.has(id);
  }

  /** List all registered role IDs */
  list(): string[] {
    this.ensureBuiltins();
    return [...this.roles.keys()];
  }

  /** Get all registered roles */
  getAll(): AgentRole[] {
    this.ensureBuiltins();
    return [...this.roles.values()];
  }

  /** Remove a role by ID */
  remove(id: string): boolean {
    this.ensureBuiltins();
    return this.roles.delete(id);
  }
}
