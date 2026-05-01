/**
 * Token estimation utilities.
 *
 * Provides a shared, consistent token count approximation used by
 * S2Chunker, memory modules, retrieval budget gating, etc.
 *
 * The GPT-style ~4 chars per token heuristic is surprisingly accurate
 * for English text and avoids a tiktoken/tokenizer dependency.
 */

/** Approximate token count using the 4-chars-per-token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Check whether adding `text` would exceed a token budget. */
export function wouldExceedBudget(
  currentTokens: number,
  text: string,
  budget: number,
): boolean {
  return currentTokens + estimateTokens(text) > budget;
}

/** Truncate text to approximately `maxTokens` tokens. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars);
}
