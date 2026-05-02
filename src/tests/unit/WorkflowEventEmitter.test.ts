import { describe, test, expect } from "bun:test";
import { WorkflowEventEmitter } from "../../core/WorkflowEventEmitter.js";
import type { StreamEvent } from "../../core/types.js";

function makeEvent(type: StreamEvent["type"], overrides: Partial<StreamEvent> = {}): StreamEvent {
  const base = { timestamp: new Date().toISOString(), ...overrides };
  switch (type) {
    case "workflow:start":
      return { type, workflowId: "w1", name: "test", stages: ["s1"], ...base } as StreamEvent;
    case "stage:start":
      return { type, stageId: "s1", module: "Test", attempt: 1, progress: { completed: 0, total: 1 }, ...base } as StreamEvent;
    case "stage:progress":
      return { type, stageId: "s1", module: "Test", token: "t", tokenIndex: 0, ...base } as StreamEvent;
    case "stage:complete":
      return { type, stageId: "s1", module: "Test", durationMs: 1, progress: { completed: 1, total: 1 }, ...base } as StreamEvent;
    case "stage:error":
      return { type, stageId: "s1", module: "Test", error: "err", attempt: 1, maxAttempts: 1, willRetry: false, ...base } as StreamEvent;
    case "workflow:complete":
      return { type, workflowId: "w1", totalDurationMs: 1, ...base } as StreamEvent;
    case "workflow:error":
      return { type, workflowId: "w1", error: "err", ...base } as StreamEvent;
  }
}

describe("WorkflowEventEmitter", () => {
  test("on() receives typed events", () => {
    const emitter = new WorkflowEventEmitter();
    const received: string[] = [];
    emitter.on("workflow:start", (e) => received.push(e.workflowId));
    emitter.emit(makeEvent("workflow:start", { workflowId: "abc" }));
    expect(received).toEqual(["abc"]);
  });

  test("once() fires only once", () => {
    const emitter = new WorkflowEventEmitter();
    let count = 0;
    emitter.once("stage:start", () => count++);
    emitter.emit(makeEvent("stage:start"));
    emitter.emit(makeEvent("stage:start"));
    expect(count).toBe(1);
  });

  test("off() removes listener", () => {
    const emitter = new WorkflowEventEmitter();
    let count = 0;
    const handler = () => count++;
    emitter.on("stage:complete", handler);
    emitter.emit(makeEvent("stage:complete"));
    emitter.off("stage:complete", handler);
    emitter.emit(makeEvent("stage:complete"));
    expect(count).toBe(1);
  });

  test("wildcard * receives all event types", () => {
    const emitter = new WorkflowEventEmitter();
    const received: string[] = [];
    emitter.on("*", (e) => received.push(e.type));
    emitter.emit(makeEvent("workflow:start"));
    emitter.emit(makeEvent("stage:start"));
    emitter.emit(makeEvent("workflow:complete"));
    expect(received).toEqual(["workflow:start", "stage:start", "workflow:complete"]);
  });

  test("emit() fires both specific and wildcard channels", () => {
    const emitter = new WorkflowEventEmitter();
    let specific = 0;
    let wildcard = 0;
    emitter.on("stage:progress", () => specific++);
    emitter.on("*", () => wildcard++);
    emitter.emit(makeEvent("stage:progress"));
    expect(specific).toBe(1);
    expect(wildcard).toBe(1);
  });

  test("toAsyncGenerator() yields events in order", async () => {
    const emitter = new WorkflowEventEmitter();
    const events: StreamEvent[] = [];

    const consume = async () => {
      for await (const e of emitter.toAsyncGenerator()) events.push(e);
    };

    const emit = async () => {
      emitter.emit(makeEvent("workflow:start", { workflowId: "w1" }));
      emitter.emit(makeEvent("stage:start", { stageId: "s1" }));
      emitter.emit(makeEvent("workflow:complete"));
    };

    await Promise.all([consume(), emit()]);
    expect(events.map((e) => e.type)).toEqual(["workflow:start", "stage:start", "workflow:complete"]);
  });

  test("toAsyncGenerator() completes on workflow:complete", async () => {
    const emitter = new WorkflowEventEmitter();
    const gen = emitter.toAsyncGenerator();
    const resultPromise = gen.next();
    emitter.emit(makeEvent("workflow:complete"));
    const result = await resultPromise;
    expect(result.value?.type).toBe("workflow:complete");
    expect(result.done).toBe(false); // yielded the terminal event
    const final = await gen.next();
    expect(final.done).toBe(true);
  });

  test("toAsyncGenerator() completes on workflow:error", async () => {
    const emitter = new WorkflowEventEmitter();
    const gen = emitter.toAsyncGenerator();
    const resultPromise = gen.next();
    emitter.emit(makeEvent("workflow:error"));
    const result = await resultPromise;
    expect(result.value?.type).toBe("workflow:error");
    const final = await gen.next();
    expect(final.done).toBe(true);
  });

  test("toAsyncGenerator() respects AbortSignal", async () => {
    const emitter = new WorkflowEventEmitter();
    const controller = new AbortController();
    const gen = emitter.toAsyncGenerator(controller.signal);
    const resultPromise = gen.next();
    controller.abort();
    const result = await resultPromise;
    expect(result.done).toBe(true);
  });

  test("removeAllListeners() cleans up", () => {
    const emitter = new WorkflowEventEmitter();
    emitter.on("workflow:start", () => {});
    emitter.on("stage:start", () => {});
    emitter.on("*", () => {});
    emitter.removeAllListeners();
    expect(emitter.listenerCount("workflow:start")).toBe(0);
    expect(emitter.listenerCount("stage:start")).toBe(0);
    expect(emitter.listenerCount("*")).toBe(0);
  });

  test("listenerCount() returns accurate count", () => {
    const emitter = new WorkflowEventEmitter();
    const fn1 = () => {};
    const fn2 = () => {};
    emitter.on("stage:error", fn1);
    emitter.on("stage:error", fn2);
    expect(emitter.listenerCount("stage:error")).toBe(2);
    emitter.off("stage:error", fn1);
    expect(emitter.listenerCount("stage:error")).toBe(1);
  });

  test("no events dropped under rapid emission (backpressure)", async () => {
    const emitter = new WorkflowEventEmitter();
    const count = 100;
    const received: number[] = [];

    const consume = async () => {
      for await (const e of emitter.toAsyncGenerator()) {
        if (e.type === "stage:progress") received.push(e.tokenIndex);
      }
    };

    const emit = async () => {
      for (let i = 0; i < count; i++) {
        emitter.emit(makeEvent("stage:progress", { tokenIndex: i }));
      }
      emitter.emit(makeEvent("workflow:complete"));
    };

    await Promise.all([consume(), emit()]);
    expect(received.length).toBe(count);
    expect(received).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});
