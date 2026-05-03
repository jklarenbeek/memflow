/**
 * SLMDatasetExporter — unit tests
 */

import { describe, it, expect } from "bun:test";
import { SLMDatasetExporterModule } from "../../../modules/evolution/SLMDatasetExporterModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("SLMDatasetExporterModule", () => {
  it("should instantiate with default config", () => {
    const mod = new SLMDatasetExporterModule();
    expect(mod.name).toBe("SLMDatasetExporter");
    expect(mod.version).toBe("0.1.0");
  });

  it("should validate custom config via Zod", () => {
    const mod = new SLMDatasetExporterModule({
      format: "sft",
      maxSamples: 500,
      quality: { minConfidence: 0.8 },
    });
    expect(mod.name).toBe("SLMDatasetExporter");
  });

  it("should reject invalid config", () => {
    expect(() => new SLMDatasetExporterModule({ format: "invalid_format" })).toThrow();
  });

  it("should handle empty Memgraph data gracefully", async () => {
    const { ctx } = createMockContext();
    const mod = new SLMDatasetExporterModule({ outputDir: "test-output" });
    const input = buildInput({}, mod.getConfigSchema().parse({ outputDir: "test-output" }));

    const result = await mod.process(input, ctx);

    expect(result.data.datasetExportPath).toBeDefined();
    expect(result.metrics?.sftCount).toBe(0);
    expect(result.metrics?.dpoCount).toBe(0);
  });

  it("should collect samples from decision/reflection data", async () => {
    const { ctx } = createMockContext({
      memgraph: {
        queryResults: {
          "Decision": [
            {
              content: "Test decision",
              outcome: "success",
              reflection: "This worked well",
              domainId: "test",
            },
          ],
        },
      },
    });

    const mod = new SLMDatasetExporterModule({ outputDir: "test-output" });
    const input = buildInput({}, mod.getConfigSchema().parse({ outputDir: "test-output" }));

    const result = await mod.process(input, ctx);
    expect(result.data.datasetExportPath).toBeDefined();
  });

  it("should return config schema", () => {
    const mod = new SLMDatasetExporterModule();
    const schema = mod.getConfigSchema();
    expect(schema).toBeDefined();
    expect(schema.parse({})).toBeDefined();
  });

  it("should report supportsLearning as false", () => {
    const mod = new SLMDatasetExporterModule();
    expect(mod.supportsLearning()).toBe(false);
  });
});
