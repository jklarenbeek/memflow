/**
 * SkillMerge — unit tests
 */

import { describe, it, expect } from "bun:test";
import { SkillMergeModule } from "../../../modules/evolution/SkillMergeModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("SkillMergeModule", () => {
  it("should instantiate with default config", () => {
    const mod = new SkillMergeModule();
    expect(mod.name).toBe("SkillMerge");
    expect(mod.version).toBe("0.1.0");
  });

  it("should handle empty clusters gracefully", async () => {
    const { ctx } = createMockContext();
    const mod = new SkillMergeModule({ persistToGraph: false });
    const config = mod.getConfigSchema().parse({ persistToGraph: false });
    const input = buildInput({ traceClusters: [] }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.distilledSkills).toEqual([]);
    expect(result.metrics?.skillCount).toBe(0);
  });
});
