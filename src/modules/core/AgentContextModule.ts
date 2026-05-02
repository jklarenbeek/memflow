/**
 * AgentContextModule — inject agent identity into workflow data
 *
 * Reads agent identity from globalConfig or input data and injects it
 * into the workflow data bus for downstream modules to access.
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";

const ConfigSchema = z.object({
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  fleetId: z.string().optional(),
  tenantId: z.string().optional(),
  trustLevel: z.number().min(0).max(3).default(1),
});

type Config = z.infer<typeof ConfigSchema>;

export class AgentContextModule implements BaseModule<Config> {
  readonly name = "AgentContext";
  readonly version = "0.5.0";
  private config: Config;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(input: ModuleInput<Config>): Promise<ModuleOutput> {
    const existing = input.data.agentIdentity;

    const identity = {
      id: this.config.agentId ?? existing?.id ?? "anonymous",
      name: this.config.agentName ?? existing?.name ?? "Anonymous Agent",
      fleetId: this.config.fleetId ?? existing?.fleetId,
      tenantId: this.config.tenantId ?? input.data.tenantId as string ?? "default",
      trustLevel: (this.config.trustLevel as 0 | 1 | 2 | 3) ?? existing?.trustLevel ?? 1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    return {
      data: {
        agentIdentity: identity,
        tenantId: identity.tenantId,
      },
      metrics: { injected: 1 },
    };
  }

  getConfigSchema() {
    return ConfigSchema;
  }

  supportsLearning() {
    return false;
  }
}
