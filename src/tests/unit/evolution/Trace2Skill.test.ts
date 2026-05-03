/**
 * Trace2Skill (composite) — unit tests
 */

import { describe, it, expect } from "bun:test";
import { Trace2SkillModule } from "../../../modules/evolution/Trace2SkillModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("Trace2SkillModule", () => {
  it("should instantiate with default config", () => {
    const mod = new Trace2SkillModule();
    expect(mod.name).toBe("Trace2Skill");
    expect(mod.version).toBe("0.1.0");
  });

  it("should handle empty experience library", async () => {
    const { ctx } = createMockContext({
      llm: {
        responses: ['[{"name": "Test Skill", "description": "A test", "applicableWhen": "always", "doPatterns": [], "dontPatterns": []}]'],
      },
    });
    const mod = new Trace2SkillModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ experienceLibrary: [] }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.traceClusters).toEqual([]);
  });
});
