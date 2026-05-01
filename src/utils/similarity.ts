/**
 * Vector / distance utilities shared across modules.
 *
 * Centralises the cosine similarity and euclidean distance functions
 * that were duplicated in both projects (HRW utils/similarity.ts,
 * MF S2Chunker inline, HRW MemgraphClient inline).
 */

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
