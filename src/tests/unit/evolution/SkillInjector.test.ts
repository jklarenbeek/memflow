/**
 * SkillInjector — unit tests
 */

import { describe, it, expect } from "bun:test";
import { SkillInjectorModule } from "../../../modules/evolution/SkillInjectorModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("SkillInjectorModule", () => {
  it("should instantiate with default config", () => {
    const mod = new SkillInjectorModule();
    expect(mod.name).toBe("SkillInjector");
    expect(mod.version).toBe("0.1.0");
  });

  it("should skip injection when no query provided", async () => {
    const { ctx } = createMockContext();
    const mod = new SkillInjectorModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({}, config);

    const result = await mod.process(input, ctx);
    expect(result.metrics?.injectedCount).toBe(0);
  });

  it("should handle empty skill graph gracefully", async () => {
    const { ctx } = createMockContext();
    const mod = new SkillInjectorModule();
    const config = mod.getConfigSchema().parse({});
    const input = buildInput({ query: "test query" }, config);

    const result = await mod.process(input, ctx);
    expect(result.metrics?.injectedCount).toBe(0);
  });

  it("should support both global and selective modes", () => {
    const global = new SkillInjectorModule({ mode: "global" });
    const selective = new SkillInjectorModule({ mode: "selective" });
    expect(global.name).toBe("SkillInjector");
    expect(selective.name).toBe("SkillInjector");
  });
});
