/**
 * Route Response Helpers
 *
 * Normalizes Memgraph/Neo4j driver return types so routes return
 * clean flat JSON instead of raw Node/Integer wrapper objects.
 */

/**
 * Unwrap a neo4j Node object to its flat properties map.
 * If the value is already a plain object (not a Node), returns it as-is.
 */
export function normalizeNode(node: unknown): Record<string, unknown> {
  if (node && typeof node === "object" && "properties" in node) {
    const props = (node as { properties: Record<string, unknown> }).properties;
    return normalizeRecord(props);
  }
  if (node && typeof node === "object") {
    return normalizeRecord(node as Record<string, unknown>);
  }
  return node as Record<string, unknown>;
}

/**
 * Recursively normalize all neo4j Integer objects in a record to plain numbers.
 * Neo4j integers have `{ low: number, high: number }` shape.
 */
export function normalizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    result[key] = normalizeValue(val);
  }
  return result;
}

/**
 * Normalize a single value: unwrap neo4j Integer → number,
 * neo4j Node → properties, recursively handle arrays.
 */
export function normalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;

  // Neo4j Integer: { low: number, high: number }
  if (typeof val === "object" && val !== null && "low" in val && "high" in val) {
    return (val as { low: number }).low;
  }

  // Neo4j Node: { identity, labels, properties, elementId }
  if (typeof val === "object" && val !== null && "properties" in val && "labels" in val) {
    return normalizeNode(val);
  }

  // Arrays: normalize each element
  if (Array.isArray(val)) {
    return val.map(normalizeValue);
  }

  return val;
}
