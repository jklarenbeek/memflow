/**
 * ModuleRegistry — enhanced singleton module factory
 *
 * Improvements over the original:
 *  1. Lazy-loading via factory functions (not static imports)
 *  2. Instance caching by (moduleName + stageId) — prevents the original
 *     bug where every `getModule()` call created a new instance
 *  3. Schema exposure via `getModuleSchema()` for HTTP API introspection
 *  4. Runtime registration via `register()` for plugins
 */

import type { BaseModule } from "./types.js";
import { ModuleNotFoundError } from "./errors.js";

type ModuleFactory = new (config?: Record<string, unknown>) => BaseModule;

/**
 * Built-in module map. Uses lazy dynamic imports to avoid loading all
 * module code at startup (tree-shakeable in production builds).
 */
const BUILTIN_MODULES: Record<string, () => Promise<ModuleFactory>> = {
  // Core
  SubWorkflow: () =>
    import("../modules/core/SubWorkflowModule.js").then((m) => m.SubWorkflowModule as unknown as ModuleFactory),

  // Chunking
  S2Chunker: () =>
    import("../modules/chunking/S2ChunkerModule.js").then((m) => m.S2ChunkerModule as unknown as ModuleFactory),
  MarkdownSpatialParser: () =>
    import("../modules/chunking/MarkdownSpatialParserModule.js").then((m) => m.MarkdownSpatialParserModule as unknown as ModuleFactory),

  // Memory — monolithic (backward compat)
  SimpleMem: () =>
    import("../modules/memory/SimpleMemModule.js").then((m) => m.SimpleMemModule as unknown as ModuleFactory),
  LightMem: () =>
    import("../modules/memory/LightMemModule.js").then((m) => m.LightMemModule as unknown as ModuleFactory),
  StructMem: () =>
    import("../modules/memory/StructMemModule.js").then((m) => m.StructMemModule as unknown as ModuleFactory),

  // Memory — atomic modules
  SlidingWindow: () =>
    import("../modules/memory/SlidingWindowModule.js").then((m) => m.SlidingWindowModule as unknown as ModuleFactory),
  DensityGate: () =>
    import("../modules/memory/DensityGateModule.js").then((m) => m.DensityGateModule as unknown as ModuleFactory),
  FactExtractor: () =>
    import("../modules/memory/FactExtractorModule.js").then((m) => m.FactExtractorModule as unknown as ModuleFactory),
  SemanticSynthesis: () =>
    import("../modules/memory/SemanticSynthesisModule.js").then((m) => m.SemanticSynthesisModule as unknown as ModuleFactory),
  NoveltyGate: () =>
    import("../modules/memory/NoveltyGateModule.js").then((m) => m.NoveltyGateModule as unknown as ModuleFactory),
  TopicSegmenter: () =>
    import("../modules/memory/TopicSegmenterModule.js").then((m) => m.TopicSegmenterModule as unknown as ModuleFactory),
  SleepConsolidation: () =>
    import("../modules/memory/SleepConsolidationModule.js").then((m) => m.SleepConsolidationModule as unknown as ModuleFactory),
  DualPerspective: () =>
    import("../modules/memory/DualPerspectiveModule.js").then((m) => m.DualPerspectiveModule as unknown as ModuleFactory),
  CrossEventConsolidation: () =>
    import("../modules/memory/CrossEventConsolidationModule.js").then((m) => m.CrossEventConsolidationModule as unknown as ModuleFactory),
  GraphPersist: () =>
    import("../modules/memory/GraphPersistModule.js").then((m) => m.GraphPersistModule as unknown as ModuleFactory),
  StructuredIndex: () =>
    import("../modules/memory/StructuredIndexModule.js").then((m) => m.StructuredIndexModule as unknown as ModuleFactory),
  PreCompression: () =>
    import("../modules/memory/PreCompressionModule.js").then((m) => m.PreCompressionModule as unknown as ModuleFactory),
  SensoryBuffer: () =>
    import("../modules/memory/SensoryBufferModule.js").then((m) => m.SensoryBufferModule as unknown as ModuleFactory),
  STMBuffer: () =>
    import("../modules/memory/STMBufferModule.js").then((m) => m.STMBufferModule as unknown as ModuleFactory),
  IntentAwarePlanner: () =>
    import("../modules/memory/IntentAwarePlannerModule.js").then((m) => m.IntentAwarePlannerModule as unknown as ModuleFactory),

  // Retrieval — monolithic (backward compat)
  LightRAGRetriever: () =>
    import("../modules/retrieval/LightRAGRetrieverModule.js").then((m) => m.LightRAGRetrieverModule as unknown as ModuleFactory),

  // Retrieval — atomic modules
  IntentClassifier: () =>
    import("../modules/retrieval/IntentClassifierModule.js").then((m) => m.IntentClassifierModule as unknown as ModuleFactory),
  VectorSearch: () =>
    import("../modules/retrieval/VectorSearchModule.js").then((m) => m.VectorSearchModule as unknown as ModuleFactory),
  GraphSearch: () =>
    import("../modules/retrieval/GraphSearchModule.js").then((m) => m.GraphSearchModule as unknown as ModuleFactory),
  KeywordSearch: () =>
    import("../modules/retrieval/KeywordSearchModule.js").then((m) => m.KeywordSearchModule as unknown as ModuleFactory),
  ResultRanker: () =>
    import("../modules/retrieval/ResultRankerModule.js").then((m) => m.ResultRankerModule as unknown as ModuleFactory),
  SymbolicSearch: () =>
    import("../modules/retrieval/SymbolicSearchModule.js").then((m) => m.SymbolicSearchModule as unknown as ModuleFactory),

  // Query
  QueryTranslator: () =>
    import("../modules/query/QueryTranslatorModule.js").then((m) => m.QueryTranslatorModule as unknown as ModuleFactory),

  // Agents — monolithic (backward compat)
  HERAOrchestrator: () =>
    import("../modules/agents/HERAOrchestratorModule.js").then((m) => m.HERAOrchestratorModule as unknown as ModuleFactory),

  // Agents — atomic modules
  PlanGenerator: () =>
    import("../modules/agents/PlanGeneratorModule.js").then((m) => m.PlanGeneratorModule as unknown as ModuleFactory),
  TrajectoryExecutor: () =>
    import("../modules/agents/TrajectoryExecutorModule.js").then((m) => m.TrajectoryExecutorModule as unknown as ModuleFactory),
  RewardComputer: () =>
    import("../modules/agents/RewardComputerModule.js").then((m) => m.RewardComputerModule as unknown as ModuleFactory),
  ExperienceReflector: () =>
    import("../modules/agents/ExperienceReflectorModule.js").then((m) => m.ExperienceReflectorModule as unknown as ModuleFactory),
  RoPEEvolver: () =>
    import("../modules/agents/RoPEEvolverModule.js").then((m) => m.RoPEEvolverModule as unknown as ModuleFactory),
  TopologyMutator: () =>
    import("../modules/agents/TopologyMutatorModule.js").then((m) => m.TopologyMutatorModule as unknown as ModuleFactory),
  FinalSynthesizer: () =>
    import("../modules/agents/FinalSynthesizerModule.js").then((m) => m.FinalSynthesizerModule as unknown as ModuleFactory),

  // Graph — monolithic (backward compat)
  MemgraphGraph: () =>
    import("../modules/graph/MemgraphGraphModule.js").then((m) => m.MemgraphGraphModule as unknown as ModuleFactory),

  // Graph — atomic modules
  ChunkIngestor: () =>
    import("../modules/graph/ChunkIngestorModule.js").then((m) => m.ChunkIngestorModule as unknown as ModuleFactory),
  EntityExtractor: () =>
    import("../modules/graph/EntityExtractorModule.js").then((m) => m.EntityExtractorModule as unknown as ModuleFactory),
  EntityDeduplicator: () =>
    import("../modules/graph/EntityDeduplicatorModule.js").then((m) => m.EntityDeduplicatorModule as unknown as ModuleFactory),
  EntityProfiler: () =>
    import("../modules/graph/EntityProfilerModule.js").then((m) => m.EntityProfilerModule as unknown as ModuleFactory),
  CommunityDetector: () =>
    import("../modules/graph/CommunityDetectorModule.js").then((m) => m.CommunityDetectorModule as unknown as ModuleFactory),

  // Generation — monolithic (backward compat)
  PriHAFusion: () =>
    import("../modules/generation/PriHAFusionModule.js").then((m) => m.PriHAFusionModule as unknown as ModuleFactory),

  // Generation — atomic modules
  QueryClarifier: () =>
    import("../modules/generation/QueryClarifierModule.js").then((m) => m.QueryClarifierModule as unknown as ModuleFactory),
  AnswerGenerator: () =>
    import("../modules/generation/AnswerGeneratorModule.js").then((m) => m.AnswerGeneratorModule as unknown as ModuleFactory),
  HallucinationValidator: () =>
    import("../modules/generation/HallucinationValidatorModule.js").then((m) => m.HallucinationValidatorModule as unknown as ModuleFactory),
  CitationInjector: () =>
    import("../modules/generation/CitationInjectorModule.js").then((m) => m.CitationInjectorModule as unknown as ModuleFactory),

  // Providers
  Embedder: () =>
    import("../modules/providers/EmbedderModule.js").then((m) => m.EmbedderModule as unknown as ModuleFactory),
  LLMProvider: () =>
    import("../modules/providers/LLMProviderModule.js").then((m) => m.LLMProviderModule as unknown as ModuleFactory),
};

export class ModuleRegistry {
  private static instance: ModuleRegistry;

  /** Resolved class constructors (cached after first lazy load) */
  private readonly resolved = new Map<string, ModuleFactory>();

  /** Custom registrations (take priority over builtins) */
  private readonly custom = new Map<string, ModuleFactory>();

  /** Instantiated module cache — keyed by `moduleName::stageId` */
  private readonly instances = new Map<string, BaseModule>();

  private constructor() {}

  static getInstance(): ModuleRegistry {
    if (!ModuleRegistry.instance) {
      ModuleRegistry.instance = new ModuleRegistry();
    }
    return ModuleRegistry.instance;
  }

  /** Reset the singleton (useful for testing) */
  static reset(): void {
    ModuleRegistry.instance = undefined as unknown as ModuleRegistry;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /** Register a custom module class at runtime (plugin system). */
  register(name: string, moduleClass: ModuleFactory): void {
    this.custom.set(name, moduleClass);
  }

  // -----------------------------------------------------------------------
  // Resolution
  // -----------------------------------------------------------------------

  /**
   * Get a module instance for a specific stage.
   *
   * Instances are cached by `moduleName::stageId` so the same stage
   * always gets the same module instance (important for stateful modules
   * like HERAOrchestrator's experience library).
   */
  async getModule(
    moduleName: string,
    config: Record<string, unknown> = {},
    stageId?: string,
  ): Promise<BaseModule> {
    const cacheKey = `${moduleName}::${stageId ?? "default"}`;

    if (this.instances.has(cacheKey)) {
      return this.instances.get(cacheKey)!;
    }

    const ModuleClass = await this.resolveClass(moduleName);
    const instance = new ModuleClass(config);
    this.instances.set(cacheKey, instance);
    return instance;
  }

  /** List all available module names (builtin + custom). */
  listModules(): string[] {
    return [
      ...new Set([...Object.keys(BUILTIN_MODULES), ...this.custom.keys()]),
    ];
  }

  /** Check whether a module name is registered. */
  hasModule(name: string): boolean {
    return this.custom.has(name) || name in BUILTIN_MODULES;
  }

  /** Clear the instance cache (for engine re-runs). */
  clearInstances(): void {
    this.instances.clear();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async resolveClass(name: string): Promise<ModuleFactory> {
    // Custom registrations take priority
    if (this.custom.has(name)) return this.custom.get(name)!;

    // Check resolved cache
    if (this.resolved.has(name)) return this.resolved.get(name)!;

    // Lazy-load from builtins
    const loader = BUILTIN_MODULES[name];
    if (!loader) {
      throw new ModuleNotFoundError(name, this.listModules());
    }

    const ModuleClass = await loader();
    this.resolved.set(name, ModuleClass);
    return ModuleClass;
  }
}