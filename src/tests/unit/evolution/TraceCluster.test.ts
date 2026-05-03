/**
 * TraceCluster — unit tests
 */

import { describe, it, expect } from "bun:test";
import { TraceClusterModule } from "../../../modules/evolution/TraceClusterModule.js";
import { createMockContext, buildInput } from "../../helpers/mocks.js";

describe("TraceClusterModule", () => {
  it("should instantiate with default config", () => {
    const mod = new TraceClusterModule();
    expect(mod.name).toBe("TraceCluster");
    expect(mod.version).toBe("0.1.0");
  });

  it("should return empty clusters when not enough experiences", async () => {
    const { ctx } = createMockContext();
    const mod = new TraceClusterModule({ k: 3 });
    const config = mod.getConfigSchema().parse({ k: 3 });
    const input = buildInput({ experienceLibrary: [] }, config);

    const result = await mod.process(input, ctx);
    expect(result.data.traceClusters).toEqual([]);
    expect(result.metrics?.clusterCount).toBe(0);
  });

  it("should cluster experiences when sufficient data is provided", async () => {
    const { ctx } = createMockContext();
    const mod = new TraceClusterModule({ k: 2 });
    const config = mod.getConfigSchema().parse({ k: 2 });

    const experiences = Array.from({ length: 10 }, (_, i) => ({
      context: `Context ${i}`,
      insight: `Insight ${i}`,
      utility: 0.5 + (i * 0.05),
    }));

    const input = buildInput({ experienceLibrary: experiences }, config);
    const result = await mod.process(input, ctx);

    expect(result.data.traceClusters).toBeDefined();
    expect(result.metrics?.experienceCount).toBe(10);
  });
});
