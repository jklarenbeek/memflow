/**
 * HarnessEvolver — unit tests
 */

import { describe, it, expect } from "bun:test";
import { HarnessEvolverModule } from "../../../modules/evolution/HarnessEvolverModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("HarnessEvolverModule", () => {
  it("should instantiate with default config", () => {
    const mod = new HarnessEvolverModule();
    expect(mod.name).toBe("HarnessEvolver");
    expect(mod.version).toBe("0.1.0");
  });

  it("should validate custom config", () => {
    const mod = new HarnessEvolverModule({ maxVersions: 5, requireRetrospective: false });
    expect(mod.name).toBe("HarnessEvolver");
  });

  it("should create a new harness for new topics", async () => {
    const { ctx } = createMockContext({
      llm: { responses: ["Initial prediction harness for test topic"] },
    });
    const mod = new HarnessEvolverModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ query: "Will Bitcoin reach $100k by 2027?" }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.predictionHarness).toBeDefined();
    expect(result.metrics?.mode).toBe("create");
  });

  it("should return noop when no query provided", async () => {
    const { ctx } = createMockContext();
    const mod = new HarnessEvolverModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({}, config);

    const result = await mod.process(input, ctx);
    expect(result.metrics?.mode).toBe("noop");
  });

  it("should inject validated harnesses on __request__", async () => {
    const { ctx } = createMockContext();
    const mod = new HarnessEvolverModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ predictionHarness: "__request__" }, config);

    const result = await mod.process(input, ctx);
    expect(result.metrics?.mode).toBe("inject");
  });

  it("should report supportsLearning as true", () => {
    const mod = new HarnessEvolverModule();
    expect(mod.supportsLearning()).toBe(true);
  });

  it("should reject invalid config values", () => {
    expect(() => new HarnessEvolverModule({ maxVersions: "not_a_number" })).toThrow();
  });

  it("should return config schema", () => {
    const mod = new HarnessEvolverModule();
    const schema = mod.getConfigSchema();
    expect(schema).toBeDefined();
    expect(schema.parse({})).toBeDefined();
  });
});
