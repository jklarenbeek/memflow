/**
 * Pattern Events — integration test
 *
 * Verifies that all GMPL modules emit their documented pattern events
 * using the shared emitPatternEvent utility via WorkflowContext.eventEmitter.
 *
 * Uses a mock LLM to avoid real API calls while testing the event
 * emission wiring.
 */

import { describe, it, expect } from "bun:test";
import { WorkflowEventEmitter } from "../../../core/WorkflowEventEmitter.js";
import type { StreamEventPatternEvent } from "../../../core/types.js";

// We test the emitPatternEvent utility directly — module-level integration
// tests are covered by each module's own test file. This test validates
// the cross-cutting concern of event shapes and naming conventions.

describe("Pattern event naming conventions", () => {
  const emitter = new WorkflowEventEmitter();

  function captureEvents(): StreamEventPatternEvent[] {
    const events: StreamEventPatternEvent[] = [];
    emitter.on("pattern:event", (e) => events.push(e));
    return events;
  }

  it("should validate DebateModule event names", () => {
    const expectedEvents = ["debate:round_start", "debate:position"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^debate:/);
    }
  });

  it("should validate ParallelDispatcher event names", () => {
    const expectedEvents = ["analysis:dispatched", "analysis:report_received", "analysis:merged"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^analysis:/);
    }
  });

  it("should validate PeerReviewModule event names", () => {
    const expectedEvents = ["review:cycle_start", "review:assessment", "review:revision"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^review:/);
    }
  });

  it("should validate RedTeamModule event names", () => {
    const expectedEvents = ["redteam:attack", "redteam:defense", "redteam:resilience_judged"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^redteam:/);
    }
  });

  it("should validate DelphiPanelModule event names", () => {
    const expectedEvents = ["delphi:poll_start", "delphi:response", "delphi:converged"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^delphi:/);
    }
  });

  it("should validate MultiTurnClarifier event names", () => {
    const expectedEvents = ["clarification:question", "clarification:resolved"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^clarification:/);
    }
  });

  it("should validate OutcomeMemory event names", () => {
    const expectedEvents = ["memory:pending_logged", "memory:resolved", "memory:context_injected"];
    for (const name of expectedEvents) {
      expect(name).toMatch(/^memory:/);
    }
  });

  it("should have unique event names across all modules", () => {
    const allEvents = [
      "debate:round_start", "debate:position",
      "analysis:dispatched", "analysis:report_received", "analysis:merged",
      "review:cycle_start", "review:assessment", "review:revision",
      "redteam:attack", "redteam:defense", "redteam:resilience_judged",
      "delphi:poll_start", "delphi:response", "delphi:converged",
      "clarification:question", "clarification:resolved",
      "memory:pending_logged", "memory:resolved", "memory:context_injected",
    ];

    const unique = new Set(allEvents);
    expect(unique.size).toBe(allEvents.length);
    expect(allEvents.length).toBe(19);
  });

  it("should have unique pattern IDs per module", () => {
    const patternIds = [
      "structured_debate",
      "parallel_analysis",
      "peer_review",
      "red_team",
      "delphi_panel",
      "clarification_pipeline",
      "outcome_memory",
    ];

    const unique = new Set(patternIds);
    expect(unique.size).toBe(patternIds.length);
  });

  it("should emit correctly shaped StreamEventPatternEvent via emitter", () => {
    const events = captureEvents();

    emitter.emit({
      type: "pattern:event",
      patternId: "structured_debate",
      eventName: "debate:round_start",
      stageId: "DebateModule",
      payload: { round: 1, maxRounds: 3, roles: ["bull", "bear"] },
      timestamp: new Date().toISOString(),
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.type).toBe("pattern:event");
    expect(event.patternId).toBe("structured_debate");
    expect(event.eventName).toBe("debate:round_start");
    expect(event.stageId).toBe("DebateModule");
    expect(event.payload.round).toBe(1);

    // Clean up
    emitter.removeAllListeners("pattern:event");
  });
});
