/**
 * Clustering — builtin centroid-based k-means
 *
 * Zero-dependency implementation for use when `ml-matrix` is not installed
 * or when `clusteringBackend: "builtin"` is configured.
 *
 * The `ml-matrix` backend (Phase 2/4) provides SVD/PCA capabilities;
 * this module covers the basic k-means use case.
 */

import { euclideanDistance } from "./similarity.js";

// ---------------------------------------------------------------------------
// K-Means
// ---------------------------------------------------------------------------

export interface KMeansResult {
  /** Final centroid positions */
  centroids: number[][];
  /** Cluster assignment for each input vector (index into centroids) */
  assignments: number[];
  /** Number of iterations until convergence */
  iterations: number;
}

/**
 * Centroid-based k-means clustering.
 *
 * @param vectors — input data points (each is a numeric array of equal length)
 * @param k — number of clusters
 * @param maxIterations — convergence limit
 * @returns cluster centroids, assignments, and iteration count
 */
export function kMeans(
  vectors: number[][],
  k: number,
  maxIterations = 100,
): KMeansResult {
  if (vectors.length === 0 || k <= 0) {
    return { centroids: [], assignments: [], iterations: 0 };
  }

  const n = vectors.length;
  const dim = vectors[0].length;
  const effectiveK = Math.min(k, n);

  // Initialize centroids via k-means++ seeding
  const centroids = initCentroids(vectors, effectiveK);
  let assignments = new Array<number>(n).fill(0);

  let converged = false;
  let iter = 0;

  while (!converged && iter < maxIterations) {
    iter++;
    converged = true;

    // Assignment step: assign each vector to nearest centroid
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let minIdx = 0;
      for (let c = 0; c < effectiveK; c++) {
        const dist = euclideanDistance(vectors[i], centroids[c]);
        if (dist < minDist) {
          minDist = dist;
          minIdx = c;
        }
      }
      if (assignments[i] !== minIdx) {
        assignments[i] = minIdx;
        converged = false;
      }
    }

    // Update step: recompute centroids
    for (let c = 0; c < effectiveK; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;

      for (let d = 0; d < dim; d++) {
        let sum = 0;
        for (const m of members) sum += m[d];
        centroids[c][d] = sum / members.length;
      }
    }
  }

  return { centroids, assignments, iterations: iter };
}

// ---------------------------------------------------------------------------
// K-Means++ initialization
// ---------------------------------------------------------------------------

function initCentroids(vectors: number[][], k: number): number[][] {
  const n = vectors.length;
  const centroids: number[][] = [];

  // Pick first centroid randomly
  const firstIdx = Math.floor(Math.random() * n);
  centroids.push([...vectors[firstIdx]]);

  // Pick remaining centroids proportional to distance²
  for (let c = 1; c < k; c++) {
    const distances = vectors.map((v) => {
      let minDist = Infinity;
      for (const cent of centroids) {
        const d = euclideanDistance(v, cent);
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });

    const totalDist = distances.reduce((a, b) => a + b, 0);
    if (totalDist === 0) {
      // All remaining points are identical to existing centroids
      centroids.push([...vectors[c % n]]);
      continue;
    }

    let threshold = Math.random() * totalDist;
    for (let i = 0; i < n; i++) {
      threshold -= distances[i];
      if (threshold <= 0) {
        centroids.push([...vectors[i]]);
        break;
      }
    }

    // Fallback if rounding issues prevented selection
    if (centroids.length <= c) {
      centroids.push([...vectors[c % n]]);
    }
  }

  return centroids;
}
