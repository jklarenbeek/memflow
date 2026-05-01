/**
 * Test Mock Factory
 *
 * Shared mock implementations for WorkflowContext, LLM, Embeddings,
 * and MemgraphClient. Every test file imports from here instead of
 * building its own mocks.
 *
 * Design: All mocks are configurable via optional overrides but have
 * sensible defaults that work out of the box.
 */

import type { WorkflowContext } from "../../core/WorkflowContext.js";
import type { Logger } from "../../providers/MemgraphClient.js";
import type { WorkflowData, ModuleInput } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

export interface LogCapture {
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
}

export function createMockLogger(): Logger & { captured: LogCapture } {
  const captured: LogCapture = { debug: [], info: [], warn: [], error: [] };
  return {
    captured,
    debug(msg: string) { captured.debug.push(msg); },
    info(msg: string) { captured.info.push(msg); },
    warn(msg: string) { captured.warn.push(msg); },
    error(msg: string) { captured.error.push(msg); },
  };
}

// ---------------------------------------------------------------------------
// LLM mock
// ---------------------------------------------------------------------------

export interface MockLLMOptions {
  /** Canned responses returned in order. Cycles back to start. */
  responses?: string[];
  /** If true, throw on invoke */
  shouldFail?: boolean;
}

export function createMockLLM(options: MockLLMOptions = {}) {
  const responses = options.responses ?? ['[{"content": "Test fact extracted from text", "type": "fact", "confidence": 0.9}]'];
  let callIndex = 0;

  return {
    invoke: async (_msgs: unknown) => {
      if (options.shouldFail) throw new Error("Mock LLM failure");
      const resp = responses[callIndex % responses.length];
      callIndex++;
      return { content: resp };
    },
    _callCount: () => callIndex,
  };
}

// ---------------------------------------------------------------------------
// Embeddings mock
// ---------------------------------------------------------------------------

export interface MockEmbeddingsOptions {
  /** Embedding dimension */
  dim?: number;
  /** If true, throw on embed */
  shouldFail?: boolean;
}

export function createMockEmbeddings(options: MockEmbeddingsOptions = {}) {
  const dim = options.dim ?? 768;
  let callCount = 0;

  return {
    embedQuery: async (_text: string) => {
      if (options.shouldFail) throw new Error("Mock embedding failure");
      callCount++;
      // Deterministic pseudo-embeddings based on call index
      return Array.from({ length: dim }, (_, i) => Math.sin(callCount + i) * 0.5);
    },
    embedDocuments: async (texts: string[]) => {
      if (options.shouldFail) throw new Error("Mock embedding failure");
      return texts.map((_, ti) => {
        callCount++;
        return Array.from({ length: dim }, (_, i) => Math.sin(callCount + i + ti) * 0.5);
      });
    },
    _callCount: () => callCount,
  };
}

// ---------------------------------------------------------------------------
// MemgraphClient mock
// ---------------------------------------------------------------------------

export interface MockMemgraphOptions {
  /** Canned query results */
  queryResults?: Record<string, unknown[]>;
  /** If true, all queries throw */
  shouldFail?: boolean;
}

export function createMockMemgraph(options: MockMemgraphOptions = {}) {
  const queries: Array<{ cypher: string; params: Record<string, unknown> }> = [];

  return {
    query: async <T = Record<string, unknown>>(
      cypher: string,
      params: Record<string, unknown> = {},
    ): Promise<T[]> => {
      queries.push({ cypher, params });
      if (options.shouldFail) throw new Error("Mock Memgraph failure");
      // Return canned results if any key in the cypher matches
      for (const [key, result] of Object.entries(options.queryResults ?? {})) {
        if (cypher.includes(key)) return result as T[];
      }
      return [] as T[];
    },

    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (options.shouldFail) throw new Error("Mock Memgraph transaction failure");
      const mockTx = {
        run: async (cypher: string, params: Record<string, unknown> = {}) => {
          queries.push({ cypher, params });
          return { records: [] };
        },
      };
      return fn(mockTx);
    },

    vectorSearch: async (
      _embedding: number[],
      _label?: string,
      _property?: string,
      _k?: number,
      _minScore?: number,
    ) => {
      if (options.shouldFail) throw new Error("Mock vector search failure");
      return [];
    },

    ensureVectorIndex: async () => {},

    persistMemoryUnits: async (units: unknown[]) => {
      queries.push({ cypher: "PERSIST_MEMORY_UNITS", params: { count: units.length } });
    },

    createDocumentGraph: async (elements: unknown[]) => {
      queries.push({ cypher: "CREATE_DOCUMENT_GRAPH", params: { count: elements.length } });
    },

    close: async () => {},

    /** Inspection helpers */
    _queries: queries,
    _queryCount: () => queries.length,
  };
}

// ---------------------------------------------------------------------------
// WorkflowContext mock
// ---------------------------------------------------------------------------

export interface MockContextOptions {
  llm?: MockLLMOptions;
  embeddings?: MockEmbeddingsOptions;
  memgraph?: MockMemgraphOptions;
}

export function createMockContext(options: MockContextOptions = {}) {
  const logger = createMockLogger();
  const llm = createMockLLM(options.llm);
  const embeddings = createMockEmbeddings(options.embeddings);
  const memgraph = createMockMemgraph(options.memgraph);

  const ctx = {
    workflowId: `test-${Date.now()}`,
    logger,
    memgraph,
    trace: [] as unknown[],
    globalConfig: {},
    getLLM: () => llm as any,
    getEmbeddings: () => embeddings as any,
    addTrace: () => {},
    shutdown: async () => {},
  } as unknown as WorkflowContext;

  return {
    ctx,
    /** Access individual mocks for assertions */
    mocks: { logger, llm, embeddings, memgraph },
  };
}

// ---------------------------------------------------------------------------
// Input builder
// ---------------------------------------------------------------------------

export function buildInput<TConfig = Record<string, unknown>>(
  data: Partial<WorkflowData> = {},
  config: TConfig = {} as TConfig,
): ModuleInput<TConfig> {
  return { data, config };
}
