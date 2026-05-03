/**
 * SkillBasisExtractor — unit tests
 */

import { describe, it, expect } from "bun:test";
import { SkillBasisExtractorModule } from "../../../modules/evolution/SkillBasisExtractorModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("SkillBasisExtractorModule", () => {
  it("should instantiate with default config", () => {
    const mod = new SkillBasisExtractorModule();
    expect(mod.name).toBe("SkillBasisExtractor");
    expect(mod.version).toBe("0.1.0");
  });

  it("should return empty basis when not enough experiences", async () => {
    const { ctx } = createMockContext();
    const mod = new SkillBasisExtractorModule({ numComponents: 5 });
    const config = mod.getConfigSchema().parse({ numComponents: 5 });
    const input = buildInput({ experienceLibrary: [] }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.skillBasis).toEqual([]);
    expect(result.metrics?.axisCount).toBe(0);
  });
});
