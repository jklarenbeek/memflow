/**
 * IntentCompiler — unit tests
 */

import { describe, it, expect } from "bun:test";
import { IntentCompilerModule } from "../../../modules/core/IntentCompilerModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("IntentCompilerModule", () => {
  it("should instantiate with default config", () => {
    const mod = new IntentCompilerModule();
    expect(mod.name).toBe("IntentCompiler");
    expect(mod.version).toBe("0.1.0");
  });

  it("should return undefined when no query provided", async () => {
    const { ctx } = createMockContext();
    const mod = new IntentCompilerModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({}, config);

    const result = await mod.process(input, ctx);
    expect(result.data.compiledWorkflow).toBeUndefined();
    expect(result.metrics?.success).toBe(false);
  });

  it("should compile valid workflow from LLM response", async () => {
    const validWorkflow = JSON.stringify({
      name: "test-workflow",
      version: "1.0",
      entry: "step1",
      stages: [{ id: "step1", module: "AgentContext", config: {}, next: null }],
    });

    const { ctx } = createMockContext({
      llm: { responses: [validWorkflow] },
    });

    const mod = new IntentCompilerModule({ outputDir: "" });
    const config = mod.getConfigSchema().parse({ outputDir: "" });
    const input = buildInput({ query: "Create a simple retrieval pipeline" }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.compiledWorkflow).toBeDefined();
    expect(result.metrics?.success).toBe(true);
  });

  it("should handle all retries failing gracefully", async () => {
    const { ctx } = createMockContext({
      llm: { responses: ["not valid json at all"] },
    });

    const mod = new IntentCompilerModule({ maxRetries: 2, outputDir: "" });
    const config = mod.getConfigSchema().parse({ maxRetries: 2, outputDir: "" });
    const input = buildInput({ query: "Build something" }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.compiledWorkflow).toBeUndefined();
    expect(result.metrics?.success).toBe(false);
  });

  it("should return config schema", () => {
    const mod = new IntentCompilerModule();
    const schema = mod.getConfigSchema();
    expect(schema).toBeDefined();
    expect(schema.parse({})).toBeDefined();
  });
});
