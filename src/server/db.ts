/**
 * Memgraph Connection Pool — Singleton MemgraphClient for the server.
 *
 * Instead of creating/destroying a connection per request (`withMemgraph`),
 * this module maintains a single long-lived client that all routes share.
 */

import { MemgraphClient, type Logger } from "../providers/MemgraphClient.js";
import type { GlobalConfig } from "../core/types.js";

/** Shared minimal logger used by the pool client. */
const poolLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(`[memgraph-pool] ${msg}`, meta ?? ""),
  debug: () => {},
};

let _client: MemgraphClient | null = null;
let _config: { uri: string; user: string; password: string } | null = null;

/**
 * Returns the singleton MemgraphClient, creating it lazily on first call.
 * Subsequent calls return the same instance regardless of config changes.
 */
export function getMemgraphPool(globalConfig: GlobalConfig): MemgraphClient {
  if (!_client) {
    _config = {
      uri: globalConfig.memgraphUri ?? process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
      user: globalConfig.memgraphUser ?? process.env.MEMGRAPH_USER ?? "memgraph",
      password: globalConfig.memgraphPassword ?? process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    };

    _client = new MemgraphClient(_config, poolLogger);
  }

  return _client;
}

/**
 * Gracefully shuts down the singleton connection.
 * Called during server shutdown.
 */
export async function shutdownPool(): Promise<void> {
  if (_client) {
    try {
      await _client.close();
    } catch {
      // Best-effort shutdown — connection may already be closed
    }
    _client = null;
    _config = null;
  }
}
