/**
 * EmbeddingModelRegistry — TOML-driven model capability registry
 *
 * Loads embedding model specs (dimensions, maxSeqLen, provider) from
 * `src/config/embedding-models.toml`.
 *
 * IMPORTANT: The embedding model is a SYSTEM-LEVEL SINGLETON.
 * Vectors from different models are incompatible in the same vector index.
 * The model is chosen at initialization and locked for the session.
 */

import { parse as parseTOML } from "smol-toml";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingModelSpec {
  /** Output vector dimensionality (e.g. 768, 1024, 1536) */
  dimensions: number;
  /** Maximum input sequence length in tokens */
  maxSeqLen: number;
  /** Which driver to use */
  provider: "openrouter" | "openai" | "ollama";
  /** Human-readable description */
  description?: string;
}

// ---------------------------------------------------------------------------
// Registry (lazy singleton)
// ---------------------------------------------------------------------------

let registry: Map<string, EmbeddingModelSpec> | null = null;

const DEFAULTS: EmbeddingModelSpec = {
  dimensions: 768,
  maxSeqLen: 512,
  provider: "ollama",
  description: "Unknown model — using safe defaults",
};

function loadRegistry(): Map<string, EmbeddingModelSpec> {
  if (registry) return registry;

  registry = new Map();

  try {
    // Resolve relative to this file's location (src/providers/)
    const thisDir = typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    const tomlPath = resolve(thisDir, "..", "config", "embedding-models.toml");
    const raw = readFileSync(tomlPath, "utf-8");
    const parsed = parseTOML(raw) as {
      models?: Record<string, Partial<EmbeddingModelSpec>>;
    };

    if (parsed.models) {
      for (const [name, spec] of Object.entries(parsed.models)) {
        registry.set(name, {
          dimensions: spec.dimensions ?? DEFAULTS.dimensions,
          maxSeqLen: spec.maxSeqLen ?? DEFAULTS.maxSeqLen,
          provider: (spec.provider as EmbeddingModelSpec["provider"]) ?? DEFAULTS.provider,
          description: spec.description,
        });
      }
    }
  } catch (err) {
    // If TOML not found, continue with empty registry (will use defaults)
    console.warn(
      `EmbeddingModelRegistry: Could not load config: ${(err as Error).message}`,
    );
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get the full spec for a model, or undefined if not in the registry. */
export function getModelSpec(model: string): EmbeddingModelSpec | undefined {
  return loadRegistry().get(model);
}

/** Get dimensions for a model, falling back to 768 for unknown models. */
export function getDimensions(model: string): number {
  return loadRegistry().get(model)?.dimensions ?? DEFAULTS.dimensions;
}

/** Get max sequence length for a model, falling back to 512. */
export function getMaxSeqLen(model: string): number {
  return loadRegistry().get(model)?.maxSeqLen ?? DEFAULTS.maxSeqLen;
}

/** Get all registered model names. */
export function listModels(): string[] {
  return Array.from(loadRegistry().keys());
}

/** Force-reload the registry (e.g. after config change). */
export function reloadRegistry(): void {
  registry = null;
  loadRegistry();
}
