import { describe, it, expect } from "bun:test";
import { cosineSimilarity, euclideanDistance, l2Normalize } from "../../utils/similarity.js";
import { estimateTokens, wouldExceedBudget, truncateToTokens } from "../../utils/tokens.js";

describe("similarity utilities", () => {
  it("cosine: identical vectors = 1.0", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("cosine: orthogonal vectors = 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("cosine: opposite vectors = -1.0", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it("cosine: mismatched lengths = 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("cosine: empty vectors = 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("euclidean: same point = 0", () => {
    expect(euclideanDistance([1, 2], [1, 2])).toBe(0);
  });

  it("euclidean: unit distance", () => {
    expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5.0, 5);
  });

  it("l2Normalize: result has unit norm", () => {
    const v = l2Normalize([3, 4]);
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("l2Normalize: zero vector unchanged", () => {
    const v = l2Normalize([0, 0, 0]);
    expect(v).toEqual([0, 0, 0]);
  });
});

describe("token utilities", () => {
  it("estimateTokens: empty string = 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimateTokens: 100 chars ≈ 25 tokens", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("wouldExceedBudget: within budget", () => {
    expect(wouldExceedBudget(10, "short", 100)).toBe(false);
  });

  it("wouldExceedBudget: over budget", () => {
    expect(wouldExceedBudget(95, "a".repeat(40), 100)).toBe(true);
  });

  it("truncateToTokens: short text unchanged", () => {
    expect(truncateToTokens("hello", 100)).toBe("hello");
  });

  it("truncateToTokens: long text truncated", () => {
    const result = truncateToTokens("a".repeat(1000), 10);
    expect(result.length).toBe(40); // 10 tokens * 4 chars
  });
});
