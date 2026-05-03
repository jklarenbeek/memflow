/**
 * Trace2Skill (composite) — unit tests
 *
 * Tests the sub-workflow-delegating Trace2SkillModule (v0.2.0).
 */

import { describe, it, expect } from "bun:test";
import { Trace2SkillModule } from "../../../modules/evolution/Trace2SkillModule.js";

describe("Trace2SkillModule", () => {
  it("should instantiate with default config", () => {
    const mod = new Trace2SkillModule();
    expect(mod.name).toBe("Trace2Skill");
    expect(mod.version).toBe("0.3.0");
  });

  it("should accept custom config values", () => {
    const mod = new Trace2SkillModule({
      k: 10,
      clusteringBackend: "ml-matrix",
      maxSkillsPerCluster: 5,
      persistToGraph: false,
    });
    expect(mod.name).toBe("Trace2Skill");
  });

  it("should expose config schema with correct defaults", () => {
    const mod = new Trace2SkillModule();
    const schema = mod.getConfigSchema();
    const defaults = schema.parse({});
    expect(defaults.k).toBe(5);
    expect(defaults.clusteringBackend).toBe("builtin");
    expect(defaults.maxSkillsPerCluster).toBe(3);
    expect(defaults.persistToGraph).toBe(true);
  });

  it("should not support learning", () => {
    const mod = new Trace2SkillModule();
    expect(mod.supportsLearning()).toBe(false);
  });
});
