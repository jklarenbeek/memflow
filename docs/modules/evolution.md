# Evolution Modules

> Self-Evolution Layer — Autonomous Skill Distillation, Dataset Export, and Prediction Harness Management

---

## Overview

The Evolution Layer adds 9 modules for autonomous improvement of the MemFlow system. These modules implement four research-backed capabilities:

1. **Skill Distillation** (Trace2Skill + AutoSkill): Extract reusable skills from experience traces
2. **Dataset Export** (Memo): Generate SLM training data from validated sessions
3. **Prediction Harness Management** (Milkyway): Version and validate prediction harnesses
4. **Workflow Compilation** (LSE): Compile natural language intents into executable workflows

### Research Foundation

| Paper | arXiv | Contribution |
|---|---|---|
| Trace2Skill | 2603.25158 | Skill extraction from agent traces via clustering + LLM merge |
| AutoSkill | 2604.17614 | Declarative skill artifacts with applicableWhen/do/don't patterns |
| Milkyway | 2604.15719 | Prediction harness with temporal contrast + retrospective validation |
| Memo | 2604.27707 | Weight-based consolidation via SLM fine-tuning datasets |
| LSE | 2603.18620 | Self-evolving context through RL-trained prompt optimization |

---

## Phase 1: SLM Dataset Export

### SLMDatasetExporter

Exports validated experience data from Memgraph as SLM training datasets in SFT and DPO formats.

**Source**: `src/modules/evolution/SLMDatasetExporterModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | (none — standalone) |
| **Writes** | `datasetExportPath`, `datasetManifest` |
| **Memgraph Labels** | `:Decision`, `:Reflection`, `:DebateSession`, `:ReviewSession`, `:RedTeamSession`, `:ModuleState` |

**Config Schema**:

```typescript
{
  format: "sft" | "dpo" | "both",      // Default: "both"
  domainFilter: string | undefined,     // Optional domain tag filter
  maxSamples: number,                   // Default: 10000
  trigger: { type: "on_demand" | "scheduled" | "threshold", ... },
  quality: {
    minConfidence: number,              // Default: 0.6
    deduplicationThreshold: number,     // Default: 0.92
    requireRetrospectiveValidation: boolean  // Default: true
  },
  includeManifest: boolean              // Default: true
}
```

**Data Sources**:
1. Resolved decisions with reflections (`:Decision` → `:Reflection`)
2. Converged debate sessions (`:DebateSession`)
3. Accepted peer reviews (`:ReviewSession` — `content` + `feedback`)
4. Resilient red team sessions (`:RedTeamSession` — `attack` + `defense`)
5. Experience reflections (`:ModuleState`)

**Sub-Workflow**: `src/workflows/sub/slm-dataset-export.json`

---

## Phase 2: Trace2Skill Pipeline

### TraceCluster

Clusters experience library entries using k-means on embeddings to group related insights.

**Source**: `src/modules/evolution/TraceClusterModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `experienceLibrary` |
| **Writes** | `traceClusters` |

**Config Schema**:

```typescript
{
  k: number,                   // Default: 5 (number of clusters)
  maxIterations: number,       // Default: 50
  tolerance: number            // Default: 0.001
}
```

### SkillMerge

LLM-powered module that merges trace clusters into declarative skill artifacts and persists them to Memgraph.

**Source**: `src/modules/evolution/SkillMergeModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `traceClusters` |
| **Writes** | `distilledSkills` |
| **Memgraph** | Creates `:Skill` nodes with `:Skill(id)` index (via `init()`) |
| **Prompt** | `trace2skill/merger` |

**Config Schema**:

```typescript
{
  maxSkillsPerCluster: number,   // Default: 3
  persistToGraph: boolean        // Default: true
}
```

**Skill Artifact Shape** (stored in Memgraph):

```typescript
{
  id: string,              // UUID
  name: string,            // Short skill name
  description: string,     // What this skill does
  applicableWhen: string,  // When to apply this skill
  doPatterns: string[],    // Positive patterns
  dontPatterns: string[],  // Negative patterns
  embedding: number[],     // Centroid embedding for vector search
  sourceTraceCount: number,
  version: number,
  createdAt: string
}
```

### SkillInjector

Retrieves relevant skills from Memgraph using vector similarity and injects them into the downstream module context.

**Source**: `src/modules/evolution/SkillInjectorModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `query`, `embeddings` |
| **Writes** | `injectedSkills`, `skillContext` |
| **Memgraph** | Vector similarity query on `:Skill` nodes |

**Config Schema**:

```typescript
{
  topK: number,                  // Default: 5
  minSimilarity: number,         // Default: 0.4
  mode: "augment" | "filter",    // Default: "augment"
  maxContextTokens: number       // Default: 2000
}
```

### Trace2Skill (Orchestrator)

Orchestrates the full TraceCluster → SkillMerge pipeline as a single workflow stage.

**Source**: `src/modules/evolution/Trace2SkillModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `experienceLibrary` |
| **Writes** | `traceClusters`, `distilledSkills` |

**Sub-Workflow**: `src/workflows/sub/trace2skill-pipeline.json`

---

## Phase 3: Prediction Harness Management

### HarnessEvolver

Manages versioned prediction harnesses per topic, with four modes of operation inspired by Milkyway.

**Source**: `src/modules/evolution/HarnessEvolverModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `query`, `predictionHarness`, `outcomeResolution` |
| **Writes** | `predictionHarness`, `internalFeedback` |
| **Memgraph** | `:PredictionHarness` nodes with `:PredictionHarness(id)` and `:PredictionHarness(topicId)` indices; `:VERSION_OF` edges |
| **Prompts** | `harness/harness_init`, `harness/internal_feedback`, `harness/retrospective_check` |

**Modes**:

| Mode | Trigger | Behavior |
|---|---|---|
| **Create** | No existing harness for topic | Generate initial harness via LLM |
| **Evolve** | Existing harness found | Generate InternalFeedback via temporal contrast, provisional update |
| **Retrospective** | `outcomeResolution` present | Validate harness update against real outcome |
| **Inject** | `predictionHarness === "__request__"` | Retrieve validated harnesses for context augmentation |

**Config Schema**:

```typescript
{
  maxVersions: number,         // Default: 10
  feedbackModel: string,       // Optional override
  retrospectiveModel: string   // Optional override
}
```

**Sub-Workflow**: `src/workflows/sub/harness-evolution.json`

---

## Phase 4: Intent Compiler + Skill Analytics

### IntentCompiler

Compiles natural language intents into executable workflow JSON by consulting the ModuleRegistry for available modules.

**Source**: `src/modules/core/IntentCompilerModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `query` |
| **Writes** | `compiledWorkflow` |
| **Prompt** | `intent-compiler/topology_designer` |

**Config Schema**:

```typescript
{
  maxRetries: number,              // Default: 3
  moduleAllowlist: string[],       // Restrict available modules
  outputDir: string | undefined    // Optional disk output
}
```

### SkillBasisExtractor

Uses PCA on the skill embedding matrix to extract principal axes that characterize the skill space.

**Source**: `src/modules/evolution/SkillBasisExtractorModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `distilledSkills` |
| **Writes** | `skillBasis` |
| **Dependency** | `ml-pca` (optional, dynamic import with helpful error message) |

**Config Schema**:

```typescript
{
  maxComponents: number,         // Default: 10
  varianceThreshold: number      // Default: 0.05
}
```

**Output Shape**:

```typescript
Array<{
  axisId: number,
  variance: number,        // Explained variance for this PC
  topSamples: string[],    // Skill names with highest loadings
  label: string            // Auto-generated axis label
}>
```

### SkillGapAnalyzer

Projects the experience library onto the skill basis to identify gaps in skill coverage.

**Source**: `src/modules/evolution/SkillGapAnalyzerModule.ts`

| Aspect | Details |
|---|---|
| **Reads** | `skillBasis`, `experienceLibrary` |
| **Writes** | `skillGaps` |

**Config Schema**:

```typescript
{
  coverageThreshold: number,     // Default: 0.3
  maxGaps: number                // Default: 5
}
```

**Output Shape**:

```typescript
Array<{
  axisId: number,
  label: string,
  coverage: number,         // 0.0–1.0 coverage score
  recommendation: string    // LLM-generated improvement suggestion
}>
```

---

## Prometheus Metrics

| Metric | Type | Description |
|---|---|---|
| `memflow_dataset_exports_total` | Counter | Total SLM dataset exports |
| `memflow_dataset_samples_total{type}` | Counter | Training samples exported by type (sft/dpo) |
| `memflow_skills_distilled_total` | Counter | Total skills distilled via Trace2Skill |
| `memflow_skill_injections_total` | Counter | Total skill injections |
| `memflow_harness_versions_total` | Counter | Total harness versions created/evolved |
| `memflow_harness_retrospective_results{result}` | Counter | Retrospective validation outcomes |
| `memflow_intent_compilations_total{result}` | Counter | Intent compilation success/failure |

## REST Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/datasets/export` | POST | Export SLM training dataset |
| `/api/v1/skills` | GET | List distilled skills |
| `/api/v1/skills/gaps` | GET | Get skill gap analysis |
| `/api/v1/skills/distill` | POST | Trigger Trace2Skill pipeline |
| `/api/v1/harness/evolve` | POST | Evolve a prediction harness |
| `/api/v1/workflows/compile` | POST | Compile NL intent → workflow |
