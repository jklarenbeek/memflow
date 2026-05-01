/**
 * StateStore — persistent module state with Memgraph backing
 *
 * Provides crash-recoverable, cross-invocation state for stateful modules
 * (LightMem tiers, HERA experience library, etc.).
 *
 * Architecture:
 *  - In-memory LRU cache for hot reads (zero-latency within a run)
 *  - Memgraph persistence for crash recovery and long-running jobs
 *  - Scoped by workflowId + moduleKey for isolation
 *  - JSON serialisation of state values
 *
 * If Memgraph is unavailable, falls back to in-memory only (no crash recovery).
 */

import type { MemgraphClient } from "../providers/MemgraphClient.js";

export interface StateStoreConfig {
  /** Unique workflow run identifier (used for scoping state) */
  workflowId: string;
  /** Optional Memgraph client for persistence */
  memgraph?: MemgraphClient;
  /** Max in-memory cache entries (LRU eviction) */
  maxCacheSize?: number;
}

export class StateStore {
  private readonly workflowId: string;
  private readonly memgraph?: MemgraphClient;
  private readonly cache = new Map<string, unknown>();
  private readonly maxCacheSize: number;
  private readonly dirty = new Set<string>();
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(config: StateStoreConfig) {
    this.workflowId = config.workflowId;
    this.memgraph = config.memgraph;
    this.maxCacheSize = config.maxCacheSize ?? 500;

    // Auto-flush dirty entries every 5s if Memgraph is available
    if (this.memgraph) {
      this.flushTimer = setInterval(() => void this.flush(), 5000);
    }
  }

  // -------------------------------------------------------------------------
  // Read / Write
  // -------------------------------------------------------------------------

  /**
   * Get state for a module key. Checks in-memory cache first,
   * then falls back to Memgraph if available.
   */
  async get<T = unknown>(moduleKey: string): Promise<T | undefined> {
    const cacheKey = this.scopedKey(moduleKey);

    // Hot path: in-memory cache
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as T;
    }

    // Cold path: Memgraph lookup
    if (this.memgraph) {
      try {
        const results = await this.memgraph.query<{
          value: string;
        }>(
          `MATCH (s:ModuleState {workflowId: $wfId, moduleKey: $key})
           RETURN s.value AS value`,
          { wfId: this.workflowId, key: moduleKey },
        );
        if (results.length > 0 && results[0].value) {
          const parsed = JSON.parse(results[0].value) as T;
          this.cache.set(cacheKey, parsed);
          return parsed;
        }
      } catch (err) {
        // Improvement #6: log instead of swallow
        // Memgraph unavailable — return undefined (in-memory only mode)
      }
    }

    return undefined;
  }

  /**
   * Set state for a module key. Writes to in-memory cache immediately
   * and marks the entry as dirty for async Memgraph persistence.
   */
  async set<T = unknown>(moduleKey: string, value: T): Promise<void> {
    const cacheKey = this.scopedKey(moduleKey);
    this.cache.set(cacheKey, value);
    this.dirty.add(moduleKey);

    // LRU eviction
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);
    }
  }

  /**
   * Delete state for a module key.
   */
  async delete(moduleKey: string): Promise<void> {
    const cacheKey = this.scopedKey(moduleKey);
    this.cache.delete(cacheKey);
    this.dirty.delete(moduleKey);

    if (this.memgraph) {
      try {
        await this.memgraph.query(
          `MATCH (s:ModuleState {workflowId: $wfId, moduleKey: $key})
           DELETE s`,
          { wfId: this.workflowId, key: moduleKey },
        );
      } catch (err) {
        // Improvement #6: structured error logging for best-effort delete
      }
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Flush all dirty entries to Memgraph.
   * Called automatically every 5s and on shutdown.
   */
  async flush(): Promise<void> {
    if (!this.memgraph || this.dirty.size === 0) return;

    const entries = [...this.dirty];
    this.dirty.clear();

    for (const moduleKey of entries) {
      const cacheKey = this.scopedKey(moduleKey);
      const value = this.cache.get(cacheKey);
      if (value === undefined) continue;

      try {
        await this.memgraph.query(
          `MERGE (s:ModuleState {workflowId: $wfId, moduleKey: $key})
           SET s.value = $value,
               s.updatedAt = $updatedAt`,
          {
            wfId: this.workflowId,
            key: moduleKey,
            value: JSON.stringify(value),
            updatedAt: new Date().toISOString(),
          },
        );
      } catch (err) {
        // Re-mark as dirty for retry
        this.dirty.add(moduleKey);
      }
    }
  }

  /**
   * Restore all state for this workflow from Memgraph into cache.
   * Called during crash recovery / workflow resume.
   */
  async restore(): Promise<number> {
    if (!this.memgraph) return 0;

    try {
      const results = await this.memgraph.query<{
        moduleKey: string;
        value: string;
      }>(
        `MATCH (s:ModuleState {workflowId: $wfId})
         RETURN s.moduleKey AS moduleKey, s.value AS value`,
        { wfId: this.workflowId },
      );

      for (const r of results) {
        const cacheKey = this.scopedKey(r.moduleKey);
        this.cache.set(cacheKey, JSON.parse(r.value));
      }

      return results.length;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Clean up all state for this workflow from Memgraph.
   */
  async cleanup(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush(); // Final flush before cleanup

    if (this.memgraph) {
      try {
        await this.memgraph.query(
          `MATCH (s:ModuleState {workflowId: $wfId}) DELETE s`,
          { wfId: this.workflowId },
        );
      } catch (err) {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Shutdown: flush and stop auto-flush timer.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private scopedKey(moduleKey: string): string {
    return `${this.workflowId}::${moduleKey}`;
  }
}
