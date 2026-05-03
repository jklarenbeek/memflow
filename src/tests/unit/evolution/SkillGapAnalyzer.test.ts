/**
 * SkillGapAnalyzer — unit tests
 */

import { describe, it, expect } from "bun:test";
import { SkillGapAnalyzerModule } from "../../../modules/evolution/SkillGapAnalyzerModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("SkillGapAnalyzerModule", () => {
  it("should instantiate with default config", () => {
    const mod = new SkillGapAnalyzerModule();
    expect(mod.name).toBe("SkillGapAnalyzer");
    expect(mod.version).toBe("0.1.0");
  });

  it("should identify gaps when low coverage axes exist", async () => {
    const { ctx } = createMockContext();
    const mod = new SkillGapAnalyzerModule({ coverageThreshold: 0.5 });
    const config = mod.getConfigSchema().parse({ coverageThreshold: 0.5 });

    const skillBasis = [
      { axisId: 0, variance: 0.7, topSamples: ["sample 1"], label: "Axis 1 (70%)" },
      { axisId: 1, variance: 0.2, topSamples: ["sample 2"], label: "Axis 2 (20%)" },
      { axisId: 2, variance: 0.1, topSamples: ["sample 3"], label: "Axis 3 (10%)" },
    ];

    const input = buildInput({ skillBasis }, config);
    const result = await mod.process(input, ctx);

    expect(result.data.skillGaps).toBeDefined();
    const gaps = result.data.skillGaps as Array<{ axisId: number }>;
    // Without experience data, all axes with variance below threshold are gaps
    expect(gaps.length).toBe(3);
    expect(gaps.find((g) => g.axisId === 0)).toBeDefined();
    expect(gaps.find((g) => g.axisId === 1)).toBeDefined();
    expect(gaps.find((g) => g.axisId === 2)).toBeDefined();
  });

  it("should report no gaps when all axes exceed threshold", async () => {
    const { ctx } = createMockContext();
    // Set threshold low enough that all axes pass
    const mod = new SkillGapAnalyzerModule({ coverageThreshold: 0.05 });
    const config = mod.getConfigSchema().parse({ coverageThreshold: 0.05 });

    // All axes have variance above 0.05 threshold
    const skillBasis = [
      { axisId: 0, variance: 0.7, topSamples: ["sample 1"], label: "Axis 1" },
      { axisId: 1, variance: 0.2, topSamples: ["sample 2"], label: "Axis 2" },
      { axisId: 2, variance: 0.1, topSamples: ["sample 3"], label: "Axis 3" },
    ];

    // Provide experience data to avoid the all-gaps-due-to-no-data short circuit
    const experienceLibrary = [
      { context: "test context", insight: "test insight", utility: 0.8 },
    ];

    const input = buildInput({ skillBasis, experienceLibrary }, config);
    const result = await mod.process(input, ctx);

    const gaps = result.data.skillGaps as Array<{ axisId: number }>;
    expect(gaps.length).toBe(0);
  });
});
