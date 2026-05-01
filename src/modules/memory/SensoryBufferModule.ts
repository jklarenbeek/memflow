/**
 * SensoryBufferModule — LightMem §3.1 Sensory Memory Buffer
 *
 * Maintains a sensory memory buffer backed by StateStore for crash
 * recovery. Accumulates pre-compressed memory units until the buffer
 * reaches capacity (th tokens), then flushes the entire buffer to
 * downstream processing.
 *
 * When the buffer hasn't reached capacity, outputs memoryUnits: []
 * (nothing for downstream) and sets metrics.bufferFull = 0.
 * When full, flushes all buffered units and resets.
 *
 * The buffer state is persisted in StateStore under key
 * `sensory::{workflowId}`, enabling crash recovery mid-ingestion.
 *
 * Reads:  memoryUnits (MemoryUnit[])
 * Writes: memoryUnits (MemoryUnit[]) — flushed buffer when full, [] otherwise
 *         metrics.bufferFull — 1 when flushed, 0 when accumulating
 */

import { z } from "zod";
import type {
  BaseModule,
  ModuleInput,
  ModuleOutput,
  MemoryUnit,
} from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Buffer capacity in estimated tokens (th from paper) */
  bufferCapacity: z.number().default(512),
  /** Chars-per-token approximation (GPT-style) */
  charsPerToken: z.number().default(4),
});

type SensoryBufferConfig = z.infer<typeof ConfigSchema>;

/** Serializable buffer state for StateStore persistence */
interface BufferState {
  units: MemoryUnit[];
  totalTokens: number;
  lastUpdate: string;
}

export class SensoryBufferModule implements BaseModule<SensoryBufferConfig> {
  readonly name = "SensoryBuffer";
  readonly version = "0.2.0";
  private config: SensoryBufferConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<SensoryBufferConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const incoming = (input.data.memoryUnits ?? []) as MemoryUnit[];

    if (incoming.length === 0) {
      return { data: { memoryUnits: [] }, metrics: { bufferFull: 0, buffered: 0 } };
    }

    // Load existing buffer from Memgraph-backed persistence
    const storeKey = `sensory::${ctx.workflowId ?? "default"}`;
    let buffer: BufferState;

    try {
      const results = await ctx.memgraph.query<{ value: string }>(
        `MATCH (s:ModuleState {workflowId: $wfId, moduleKey: $key})
         RETURN s.value AS value`,
        { wfId: ctx.workflowId, key: storeKey },
      );
      buffer = results.length > 0 && results[0].value
        ? (JSON.parse(results[0].value) as BufferState)
        : { units: [], totalTokens: 0, lastUpdate: new Date().toISOString() };
    } catch {
      buffer = { units: [], totalTokens: 0, lastUpdate: new Date().toISOString() };
    }

    // Accumulate incoming units into buffer
    for (const unit of incoming) {
      const tokenCount = Math.ceil(unit.content.length / this.config.charsPerToken);
      buffer.units.push(unit);
      buffer.totalTokens += tokenCount;
    }

    buffer.lastUpdate = new Date().toISOString();

    // Check if buffer has reached capacity
    if (buffer.totalTokens >= this.config.bufferCapacity) {
      // Flush: output all buffered units and reset
      const flushed = [...buffer.units];
      const flushedTokens = buffer.totalTokens;

      // Reset buffer in StateStore
      const emptyBuffer: BufferState = {
        units: [],
        totalTokens: 0,
        lastUpdate: new Date().toISOString(),
      };

      try {
        await ctx.memgraph.query(
          `MERGE (s:ModuleState {workflowId: $wfId, moduleKey: $key})
           SET s.value = $value, s.updatedAt = $updatedAt`,
          { wfId: ctx.workflowId, key: storeKey, value: JSON.stringify(emptyBuffer), updatedAt: new Date().toISOString() },
        );
      } catch { /* continue even if persistence fails */ }

      ctx.logger.info(
        `SensoryBuffer: Flushed ${flushed.length} units (${flushedTokens} tokens ≥ ${this.config.bufferCapacity} capacity)`,
      );

      return {
        data: { memoryUnits: flushed },
        metrics: {
          bufferFull: 1,
          flushed: flushed.length,
          flushedTokens,
          buffered: 0,
        },
      };
    }

    // Buffer not full — persist and output nothing
    try {
      await ctx.memgraph.query(
        `MERGE (s:ModuleState {workflowId: $wfId, moduleKey: $key})
         SET s.value = $value, s.updatedAt = $updatedAt`,
        { wfId: ctx.workflowId, key: storeKey, value: JSON.stringify(buffer), updatedAt: new Date().toISOString() },
      );
    } catch { /* continue */ }

    ctx.logger.debug(
      `SensoryBuffer: Buffered ${buffer.units.length} units ` +
        `(${buffer.totalTokens}/${this.config.bufferCapacity} tokens)`,
    );

    return {
      data: { memoryUnits: [] },
      metrics: {
        bufferFull: 0,
        buffered: buffer.units.length,
        bufferedTokens: buffer.totalTokens,
      },
    };
  }

  getConfigSchema() { return ConfigSchema; }
  supportsLearning() { return false; }
}
