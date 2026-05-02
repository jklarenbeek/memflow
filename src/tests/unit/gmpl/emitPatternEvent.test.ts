/**
 * emitPatternEvent — unit tests
 *
 * Validates the shared GMPL pattern event emission utility.
 */

import { describe, it, expect, mock } from "bun:test";
import { emitPatternEvent } from "../../../gmpl/emitPatternEvent.js";
import { WorkflowEventEmitter } from "../../../core/WorkflowEventEmitter.js";

describe("emitPatternEvent", () => {
  it("should emit a pattern:event when emitter is available on context", () => {
    const emitter = new WorkflowEventEmitter();
    const events: unknown[] = [];
    emitter.on("pattern:event", (e) => events.push(e));

    const context = { eventEmitter: emitter };

    emitPatternEvent(context, "structured_debate", "debate:round_start", "DebateModule", {
      round: 1,
      maxRounds: 3,
    });

    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe("pattern:event");
    expect(event.patternId).toBe("structured_debate");
    expect(event.eventName).toBe("debate:round_start");
    expect(event.stageId).toBe("DebateModule");
    expect((event.payload as Record<string, unknown>).round).toBe(1);
    expect((event.payload as Record<string, unknown>).maxRounds).toBe(3);
    expect(typeof event.timestamp).toBe("string");
  });

  it("should no-op when emitter is undefined", () => {
    const context = {};

    // Should not throw
    emitPatternEvent(context, "structured_debate", "debate:round_start", "DebateModule", {
      round: 1,
    });
  });

  it("should no-op when emitter is null", () => {
    const context = { eventEmitter: null };

    // Should not throw
    emitPatternEvent(context, "structured_debate", "debate:round_start", "DebateModule", {
      round: 1,
    });
  });

  it("should no-op when context is undefined", () => {
    // Should not throw
    emitPatternEvent(undefined, "structured_debate", "debate:round_start", "DebateModule", {
      round: 1,
    });
  });

  it("should emit on wildcard channel as well", () => {
    const emitter = new WorkflowEventEmitter();
    const wildcardEvents: unknown[] = [];
    emitter.on("*", (e) => wildcardEvents.push(e));

    const context = { eventEmitter: emitter };

    emitPatternEvent(context, "parallel_analysis", "analysis:dispatched", "ParallelDispatcher", {
      analysts: ["a1", "a2"],
    });

    expect(wildcardEvents.length).toBe(1);
  });

  it("should produce correctly typed StreamEventPatternEvent shape", () => {
    const emitter = new WorkflowEventEmitter();
    let capturedEvent: Record<string, unknown> | undefined;
    emitter.on("pattern:event", (e) => {
      capturedEvent = e as unknown as Record<string, unknown>;
    });

    emitPatternEvent({ eventEmitter: emitter }, "red_team", "redteam:attack", "RedTeamModule", {
      attackerId: "attacker_1",
      strategy: "edge_case_injection",
      round: 2,
    });

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.type).toBe("pattern:event");
    expect(capturedEvent!.patternId).toBe("red_team");
    expect(capturedEvent!.eventName).toBe("redteam:attack");
    expect(capturedEvent!.stageId).toBe("RedTeamModule");

    const payload = capturedEvent!.payload as Record<string, unknown>;
    expect(payload.attackerId).toBe("attacker_1");
    expect(payload.strategy).toBe("edge_case_injection");
    expect(payload.round).toBe(2);
  });
});
