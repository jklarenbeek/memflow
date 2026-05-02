# HERA Agent Pipeline

> **Paper**: HERA  
> **Composite Wrapper**: `HERAOrchestratorModule` (`modules/agents/HERAOrchestratorModule.ts`)  
> **Sub-Workflow**: `hera-orchestration.json` — Plan → Execute → Reward → Reflect → [RoPE] → [Mutate] → Synthesize

The HERA pipeline implements a self-improving multi-agent research system. Given a query and retrieval context, it generates an agent topology, executes the agent plan step-by-step, computes composite reward scores, reflects on performance, and synthesizes a final answer. Conditional branches enable prompt evolution (RoPE) and topology mutation after failure.

The `HERAOrchestratorModule` wrapper is the most stateful composite module. It maintains persistent cross-run state: `evolvedRolePrompts`, `previousTrajectories`, `consecutiveFailures`, `mutatedTopology`, and `agentFailureBuffers`. These are passed as `_stageConfigs` overrides so that sub-workflow stages receive the accumulated state from prior executions.

**Config (wrapper)**:
- `maxAgents` (5) — max agents in a topology
- `enableRoPE` (true) — enable Role-playing Prompt Evolution
- `enableTopologyMutation` (true) — enable structural topology changes
- `topologyMutationThreshold` (3) — consecutive failures before topology mutation triggers
- `grpoGroupSize` (3) — trajectory comparison group size for GRPO

---

## Atomic Modules

### PlanGenerator

| | |
|---|---|
| **File** | `modules/agents/PlanGeneratorModule.ts` |
| **Input** | `query`, `retrievalResult` |
| **Output** | `agentPlan` |

LLM generates query-specific agent topology from available roles, informed by experience library and persisted topology mutations.

### TrajectoryExecutor

| | |
|---|---|
| **File** | `modules/agents/TrajectoryExecutorModule.ts` |
| **Input** | `query`, `agentPlan` |
| **Output** | `trajectory` |

Sequential multi-agent execution with accumulated context. Uses evolved prompts (RoPE) when available, TOML role prompts as fallback.

### RewardComputer

| | |
|---|---|
| **File** | `modules/agents/RewardComputerModule.ts` |
| **Input** | `trajectory` |
| **Output** | `trajectory` (with `reward` score) |
| **Config** | `retrievalWeight` (0.3), `stepSuccessWeight` (0.25), `completenessWeight` (0.25), `efficiencyWeight` (0.2) |

Configurable multi-signal composite reward.

### ExperienceReflector

| | |
|---|---|
| **File** | `modules/agents/ExperienceReflectorModule.ts` |
| **Input** | `trajectory` |
| **Output** | `insights`, `experienceLibrary` |

GRPO-style group comparison — ranks current vs prior trajectories, extracts insights, updates library with utility-based pruning.

### RoPEEvolver

| | |
|---|---|
| **File** | `modules/agents/RoPEEvolverModule.ts` |
| **Paper** | HERA §3.4 |
| **Input** | `trajectory`, `evolvedRolePrompts`, `agentFailureBuffers` |
| **Output** | `evolvedRolePrompts` |
| **Config** | `failureThreshold`, `maxPromptLength` |

Identifies weakest agent, runs contrastive LLM analysis. Prompt updates are consolidated via projection ΠC (`ρᵢᵗ⁺¹ = ΠC(ρᵢᵗ ⊕ Δρᵢ)`) — merging not overwriting. Integrates per-agent failure buffer for recurring pattern analysis.

### TopologyMutator

| | |
|---|---|
| **File** | `modules/agents/TopologyMutatorModule.ts` |
| **Paper** | HERA §3.5 |
| **Input** | `trajectory`, `consecutiveFailures` |
| **Output** | `mutatedTopology` |
| **Config** | `mutationTriggerCount` |

After N consecutive failures, LLM recommends structural changes (replace/augment agents). Mutations persist and feed into future `PlanGenerator` calls.

### FinalSynthesizer

| | |
|---|---|
| **File** | `modules/agents/FinalSynthesizerModule.ts` |
| **Paper** | HERA §3.3 |
| **Input** | `trajectory` |
| **Output** | `finalAnswer`, `trajectory` (enriched) |
| **Config** | `maxStepChars` (400) |
| **Streaming** | ✅ `processStream()` via LangChain `.stream()` |

Synthesizes accumulated agent trajectory steps into a polished, coherent answer. Implements `StreamableModule` for real-time token streaming via SSE.
