import { describe, it, expect } from "bun:test";
import { MultiTurnClarifierModule } from "../../../gmpl/modules/MultiTurnClarifierModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("MultiTurnClarifierModule", () => {
  it("should skip clarification for clear queries when complexityGate is on", async () => {
    const { ctx } = createMockContext();
    const mod = new MultiTurnClarifierModule({ complexityGate: true });

    const output = await mod.process(
      buildInput({ query: "List all employees in department 5 with salary above 50000" }),
      ctx,
    );

    expect(output.metrics?.skippedComplexityGate).toBe(true);
    expect(output.data.query).toBe("List all employees in department 5 with salary above 50000");
  });

  it("should generate questions for fuzzy queries", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: ['{"questions": ["What type of service?", "Price range?"]}'],
      },
    });

    const mod = new MultiTurnClarifierModule({ maxTurns: 3 });
    const output = await mod.process(
      buildInput({ query: "what is best" }),
      ctx,
    );

    expect(output.metrics?.pendingClarification).toBe(true);
    expect(output.data.clarifications).toBeDefined();
    expect((output.data.clarifications as string[]).length).toBeGreaterThan(0);
  });

  it("should resolve intent from user response", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: [
          '{"resolved": true, "refined_query": "best dental clinics in Central HK under $500", "intent": "dental_service_search", "sub_queries": ["dental clinics Central", "price comparison"]}',
        ],
      },
    });

    const mod = new MultiTurnClarifierModule({ maxTurns: 5 });
    const state = {
      originalQuery: "what is best",
      turns: [
        { turn: 1, questions: ["What type of service?"], response: "dental clinic", timestamp: new Date().toISOString() },
      ],
      currentTurn: 1,
      intentResolved: false,
    };

    const output = await mod.process(
      buildInput({
        query: "what is best",
        clarificationState: state,
        userClarificationResponse: "dental clinic in Central, under $500",
      }),
      ctx,
    );

    expect(output.data.query).toBe("best dental clinics in Central HK under $500");
    expect(output.metrics?.clarified).toBe(true);
  });

  it("should respect maxTurns limit", async () => {
    const { ctx } = createMockContext();
    const mod = new MultiTurnClarifierModule({ maxTurns: 1 });

    const state = {
      originalQuery: "what is best",
      turns: [{ turn: 1, questions: ["Q1"], timestamp: new Date().toISOString() }],
      currentTurn: 1,
      intentResolved: false,
    };

    const output = await mod.process(
      buildInput({ query: "what is best", clarificationState: state }),
      ctx,
    );

    expect(output.metrics?.maxTurnsReached).toBe(true);
  });
});
