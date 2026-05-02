/**
 * DomainRegistry — registry for domain adapter plugins
 *
 * Domain adapters bundle data providers, evaluators, prompt packs,
 * entity schemas, and observability labels into a single registration
 * unit. Patterns and modules query this registry to obtain domain-specific
 * "fuel" while keeping orchestration logic generic.
 */

import type { DomainAdapter } from "./types.js";

export class DomainRegistry {
  private static instance: DomainRegistry;

  private readonly adapters = new Map<string, DomainAdapter>();

  private constructor() {}

  static getInstance(): DomainRegistry {
    if (!DomainRegistry.instance) {
      DomainRegistry.instance = new DomainRegistry();
    }
    return DomainRegistry.instance;
  }

  /** Reset the singleton (useful for testing) */
  static reset(): void {
    DomainRegistry.instance = undefined as unknown as DomainRegistry;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a domain adapter.
   *
   * @throws if an adapter with the same ID is already registered
   * @throws if the adapter is missing required fields
   */
  register(adapter: DomainAdapter): void {
    this.validate(adapter);

    if (this.adapters.has(adapter.id)) {
      throw new Error(
        `DomainRegistry: Adapter "${adapter.id}" is already registered. ` +
          `Use a unique ID or call remove() first.`,
      );
    }

    this.adapters.set(adapter.id, adapter);
  }

  // -----------------------------------------------------------------------
  // Retrieval
  // -----------------------------------------------------------------------

  /** Get an adapter by ID, or undefined if not found */
  get(id: string): DomainAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Check if an adapter is registered */
  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /** List all registered adapter IDs */
  list(): string[] {
    return [...this.adapters.keys()];
  }

  /** Get all registered adapters */
  getAll(): DomainAdapter[] {
    return [...this.adapters.values()];
  }

  /** Remove an adapter by ID */
  remove(id: string): boolean {
    return this.adapters.delete(id);
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  private validate(adapter: DomainAdapter): void {
    if (!adapter.id || typeof adapter.id !== "string") {
      throw new Error("DomainRegistry: Adapter must have a non-empty string 'id'.");
    }
    if (!adapter.version || typeof adapter.version !== "string") {
      throw new Error(`DomainRegistry: Adapter "${adapter.id}" must have a 'version'.`);
    }
    if (!adapter.dataProviders || typeof adapter.dataProviders !== "object") {
      throw new Error(`DomainRegistry: Adapter "${adapter.id}" must have 'dataProviders'.`);
    }
    if (typeof adapter.outcomeEvaluator !== "function") {
      throw new Error(`DomainRegistry: Adapter "${adapter.id}" must have an 'outcomeEvaluator' function.`);
    }
    if (typeof adapter.metricsCalculator !== "function") {
      throw new Error(`DomainRegistry: Adapter "${adapter.id}" must have a 'metricsCalculator' function.`);
    }
  }
}
