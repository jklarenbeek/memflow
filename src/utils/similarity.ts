/**
 * Vector / distance utilities shared across modules.
 *
 * Centralises the cosine similarity and euclidean distance functions
 * that were duplicated in both projects (HRW utils/similarity.ts,
 * MF S2Chunker inline, HRW MemgraphClient inline).
 *
 * === Improvement #14: Configurable similarity function ===
 * Extracted into a strategy pattern with `cosine`, `euclidean`, `dotProduct`
 * options. Modules that use similarity (NoveltyGate, SemanticSynthesis,
 * CrossEventConsolidation, SleepConsolidation) can now accept a
 * `similarityFunction` config parameter.
 */

// ---------------------------------------------------------------------------
// Supported similarity / distance strategies
// ---------------------------------------------------------------------------

export type SimilarityFunction = "cosine" | "euclidean" | "dotProduct";

/**
 * Compute similarity between two vectors using the specified strategy.
 *
 * All strategies return a value where **higher = more similar**:
 *  - `cosine`:     [0, 1] for non-negative embeddings, [-1, 1] in general
 *  - `dotProduct`:  unbounded (higher = more similar)
 *  - `euclidean`:   returns `1 / (1 + distance)` so range is (0, 1]
 *
 * Returns 0 for invalid / mismatched inputs.
 */
export function similarity(
  a: number[],
  b: number[],
  fn: SimilarityFunction = "cosine",
): number {
  switch (fn) {
    case "cosine":
      return cosineSimilarity(a, b);
    case "dotProduct":
      return dotProductSimilarity(a, b);
    case "euclidean":
      return euclideanSimilarity(a, b);
    default:
      return cosineSimilarity(a, b);
  }
}

// ---------------------------------------------------------------------------
// Individual strategies
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 * Returns 0 for invalid / mismatched inputs.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Dot product similarity between two vectors.
 * Returns 0 for invalid / mismatched inputs.
 */
export function dotProductSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Euclidean similarity: `1 / (1 + euclideanDistance(a, b))`.
 * Returns a value in (0, 1] where 1 means identical vectors.
 */
export function euclideanSimilarity(a: number[], b: number[]): number {
  const dist = euclideanDistance(a, b);
  return dist === Infinity ? 0 : 1 / (1 + dist);
}

/**
 * Euclidean distance between two vectors.
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * L2-normalise a vector in place. No-op on zero vectors.
 * Returns the same array reference for chaining.
 */
export function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
