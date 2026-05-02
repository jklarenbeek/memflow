/**
 * WorkflowContext EventEmitter Injection — unit tests
 *
 * Validates that WorkflowEngine correctly injects the event emitter
 * into WorkflowContext so pattern modules can use it cleanly.
 */

import { describe, it, expect } from "bun:test";
import { WorkflowEngine } from "../../../core/WorkflowEngine.js";
import { ModuleRegistry } from "../../../core/ModuleRegistry.js";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../../core/types.js";
import type { WorkflowContext } from "../../../core/WorkflowContext.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock module that captures context.eventEmitter state
// ---------------------------------------------------------------------------

class EmitterProbeModule implements BaseModule {
  readonly name = "EmitterProbe";
  readonly version = "0.5.1";
  static capturedEmitter: unknown = "NOT_CALLED";

  constructor(_config?: Record<string, unknown>) {}

  async process(input: ModuleInput, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    EmitterProbeModule.capturedEmitter = ctx.eventEmitter;
    return { data: { probeResult: ctx.eventEmitter !== undefined } };
  }

  getConfigSchema() {
    return z.object({});
  }
  supportsLearning() {
    return false;
  }
}

// Module that emits a pattern event via context.eventEmitter
class EventEmitterModule implements BaseModule {
  readonly name = "EventEmitter";
  readonly version = "0.5.1";

  constructor(_config?: Record<string, unknown>) {}

  async process(input: ModuleInput, context: unknown): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit({
        type: "pattern:event",
        patternId: "test_pattern",
        eventName: "test:event",
        stageId: "EventEmitter",
        payload: { key: "value" },
        timestamp: new Date().toISOString(),
      });
    }
    return { data: {} };
  }

  getConfigSchema() {
    return z.object({});
  }
  supportsLearning() {
    return false;
  }
}

describe("WorkflowContext eventEmitter injection", () => {
  it("should inject eventEmitter into context during initialize()", async () => {
    const registry = ModuleRegistry.getInstance();

    // Register probe module as a constructor
    registry.register("EmitterProbe", EmitterProbeModule as unknown as new (config?: Record<string, unknown>) => BaseModule);

    const engine = new WorkflowEngine({
      name: "emitter-test",
      version: "1.0",
      entry: "probe",
      stages: [
        {
          id: "probe",
          module: "EmitterProbe",
          config: {},
          next: null,
        },
      ],
    });

    try {
      await engine.initialize({ logLevel: "error" });

      // Run the workflow — the probe module will capture the emitter
      await engine.run({ query: "test" });

      // The emitter should have been injected
      expect(EmitterProbeModule.capturedEmitter).toBeDefined();
      expect(EmitterProbeModule.capturedEmitter).not.toBe("NOT_CALLED");
      expect(typeof (EmitterProbeModule.capturedEmitter as { emit: unknown }).emit).toBe("function");
    } finally {
      await engine.shutdown();
      registry.clearInstances();
    }
  });

  it("should have eventEmitter available on engine.events", () => {
    const engine = new WorkflowEngine({
      name: "events-access-test",
      version: "1.0",
      entry: "noop",
      stages: [
        {
          id: "noop",
          module: "EmitterProbe",
          config: {},
          next: null,
        },
      ],
    });

    expect(engine.events).toBeDefined();
    expect(typeof engine.events.on).toBe("function");
    expect(typeof engine.events.emit).toBe("function");
  });

  it("should emit pattern:event through context.eventEmitter during stage execution", async () => {
    const registry = ModuleRegistry.getInstance();

    registry.register("EventEmitter", EventEmitterModule as unknown as new (config?: Record<string, unknown>) => BaseModule);

    const engine = new WorkflowEngine({
      name: "emit-test",
      version: "1.0",
      entry: "emit",
      stages: [
        {
          id: "emit",
          module: "EventEmitter",
          config: {},
          next: null,
        },
      ],
    });

    const events: unknown[] = [];
    engine.events.on("pattern:event", (e) => events.push(e));

    try {
      await engine.initialize({ logLevel: "error" });
      await engine.run({ query: "test" });

      expect(events.length).toBe(1);
      const event = events[0] as Record<string, unknown>;
      expect(event.type).toBe("pattern:event");
      expect(event.patternId).toBe("test_pattern");
      expect(event.eventName).toBe("test:event");
    } finally {
      await engine.shutdown();
      registry.clearInstances();
    }
  });
});
