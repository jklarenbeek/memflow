/**
 * Clustering (builtin k-means) — unit tests
 */

import { describe, it, expect } from "bun:test";
import { kMeans } from "../../../utils/clustering.js";

describe("kMeans", () => {
  it("should converge on known clusters", () => {
    // Create two obvious clusters: one near [0, 0], one near [10, 10]
    const vectors = [
      [0.1, 0.2], [0.2, 0.1], [0.3, 0.3], [0.1, 0.3], [0.2, 0.2],
      [9.9, 10.1], [10.1, 9.9], [10.0, 10.0], [9.8, 10.2], [10.2, 9.8],
    ];

    const result = kMeans(vectors, 2);

    expect(result.centroids.length).toBe(2);
    expect(result.assignments.length).toBe(10);

    // First 5 should be in the same cluster
    const firstCluster = result.assignments[0];
    for (let i = 1; i < 5; i++) {
      expect(result.assignments[i]).toBe(firstCluster);
    }

    // Last 5 should be in a different cluster
    const secondCluster = result.assignments[5];
    expect(secondCluster).not.toBe(firstCluster);
    for (let i = 6; i < 10; i++) {
      expect(result.assignments[i]).toBe(secondCluster);
    }
  });

  it("should handle empty input", () => {
    const result = kMeans([], 3);
    expect(result.centroids).toEqual([]);
    expect(result.assignments).toEqual([]);
    expect(result.iterations).toBe(0);
  });

  it("should handle k > n by reducing effective k", () => {
    const vectors = [[1, 2], [3, 4]];
    const result = kMeans(vectors, 5);
    expect(result.centroids.length).toBe(2);
    expect(result.assignments.length).toBe(2);
  });
});
