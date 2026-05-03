/**
 * PromptLoader — load and render LLM prompts from TOML files
 *
 * All LLM prompts are externalised as TOML files in `src/prompts/`.
 * Each file declares:
 *  - [meta]     — name, version, description
 *  - [config]   — temperature, max_tokens, and any module-specific knobs
 *  - [[messages]] — ordered chat messages with {{variable}} placeholders
 *
 * Template variables in message `content` fields are rendered at call-time
 * via `renderMessages(prompt, { key: value })`.
 *
 * === Improvement #8: Startup validation ===
 * `validateAllPrompts()` scans the prompts directory and verifies all
 * referenced TOML files parse correctly, surfacing errors at startup.
 *
 * === Improvement #15: Hot-reload ===
 * `startPromptWatcher()` uses `fs.watch` with debounce to invalidate
 * the prompt cache when TOML files are modified on disk. This eliminates
 * server restarts during prompt-engineering loops.
 */

import { parse as parseToml } from "smol-toml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptMeta {
  name: string;
  version: string;
  description?: string;
  module?: string;
}

export interface PromptConfig {
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
  [key: string]: unknown;
}

export interface PromptTemplate {
  meta: PromptMeta;
  config: PromptConfig;
  messages: PromptMessage[];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, PromptTemplate>();

// ---------------------------------------------------------------------------
// Resolve prompts root directory
// ---------------------------------------------------------------------------

function promptsRoot(): string {
  // Works in both compiled (dist/) and source (src/) trees
  const thisFile =
    typeof __filename !== "undefined"
      ? __filename
      : fileURLToPath(import.meta.url);
  const utilsDir = path.dirname(thisFile);
  const srcDir = path.dirname(utilsDir);
  return path.join(srcDir, "prompts");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a prompt template from `src/prompts/<promptPath>.toml`.
 *
 * @param promptPath — slash-separated path relative to prompts dir,
 *   e.g. `"simplemem/extraction"` → `src/prompts/simplemem/extraction.toml`
 * @param bypassCache — force re-read from disk
 */
export function loadPrompt(
  promptPath: string,
  bypassCache = false,
): PromptTemplate {
  if (!bypassCache && cache.has(promptPath)) {
    return cache.get(promptPath)!;
  }

  const filePath = path.join(promptsRoot(), `${promptPath}.toml`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseToml(raw) as Record<string, unknown>;

  const template: PromptTemplate = {
    meta: (parsed.meta ?? { name: promptPath, version: "1.0" }) as PromptMeta,
    config: (parsed.config ?? {}) as PromptConfig,
    messages: (
      (parsed.messages as Array<Record<string, unknown>>) ?? []
    ).map((m) => ({
      role: ((m.role ?? m.type) as PromptMessage["role"]) ?? "user",
      content: (m.content as string) ?? "",
    })),
  };

  cache.set(promptPath, template);
  return template;
}

/**
 * Render a prompt template's messages by substituting `{{key}}` placeholders.
 *
 * @returns A new array of messages with all variables expanded.
 */
export function renderMessages(
  template: PromptTemplate,
  variables: Record<string, string | number> = {},
): PromptMessage[] {
  return template.messages.map((msg) => ({
    role: msg.role,
    content: substituteVars(msg.content, variables),
  }));
}

/**
 * Convenience: load + render in one call.
 */
export function loadAndRender(
  promptPath: string,
  variables: Record<string, string | number> = {},
): { messages: PromptMessage[]; config: PromptConfig } {
  const tpl = loadPrompt(promptPath);
  return {
    messages: renderMessages(tpl, variables),
    config: tpl.config,
  };
}

/**
 * Load a role prompt TOML and return the system message content.
 */
export function loadRolePrompt(roleName: string): string {
  try {
    const tpl = loadPrompt(`hera/roles/${roleName}`);
    const sysMsg = tpl.messages.find((m) => m.role === "system" || m.type === "system");
    return sysMsg?.content ?? `You are ${roleName}.`;
  } catch {
    return `You are ${roleName}.`;
  }
}

/**
 * Clear the prompt cache (useful for testing or hot-reload).
 */
export function clearPromptCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Improvement #8: Startup prompt validation
// ---------------------------------------------------------------------------

/**
 * Known prompt references used by modules across the codebase.
 * Any `loadAndRender("...")` call in a module should have its key listed here.
 */
const KNOWN_PROMPT_REFS: string[] = [
  // SimpleMem
  "simplemem/extraction",
  "simplemem/density_gating",
  "simplemem/synthesis",
  "simplemem/intent_aware_planning",
  // LightMem
  "lightmem/consolidation",
  "lightmem/pre_compression",
  // StructMem
  "structmem/dual_perspective",
  "structmem/consolidation_synthesis",
  // Retrieval
  "retrieval/intent_inference",
  // HERA
  "hera/plan_generation",
  "hera/reflection",
  "hera/reflection_single",
  "hera/synthesis",
  "hera/rope_evolution",
  "hera/topology_mutation",
  // PriHA
  "priha/clarification",
  "priha/generation",
  "priha/refinement",
  "priha/validation",
  "priha/web-search-rerank",
  // Query
  "query/hyde",
  "query/multi_query",
  "query/step_back",
  "query/query_rewriting",
  "query/intent_clarification",
  // Graph
  "graph/entity_extraction",
  "graph/entity_profiling",
  "graph/deduplication",
  // Evolution: Dataset Export
  "dataset/synthesis",           // §future — LLM quality-enhancement pass for raw training samples (Memo §3)
  // Evolution: Trace2Skill pipeline (3-stage: cluster → analyze → merge)
  "trace2skill/analyst",         // §future — per-cluster pattern analysis, produces analyst reports for SkillMerge (Trace2Skill §2.2)
  "trace2skill/merger",
  "trace2skill/injection",
  // Evolution: Harness Evolver
  "harness/internal_feedback",
  "harness/retrospective_check",
  "harness/harness_init",
  // Evolution: Intent Compiler (3-stage: assign → design → complete)
  "intent-compiler/role_assigner",       // §future — stage 1: agent/role assignment from RoleRegistry (MASFactory §3)
  "intent-compiler/topology_designer",
  "intent-compiler/semantic_completer",  // §future — stage 3: config completion, inputMap/outputMap wiring (MASFactory §3)
];

export interface PromptValidationResult {
  valid: string[];
  missing: string[];
  parseErrors: Array<{ path: string; error: string }>;
}

/**
 * Validate that all known TOML prompt references exist and parse correctly.
 *
 * Returns a structured result with valid, missing, and errored prompts.
 * Designed to be called during `WorkflowContext.create()` for fail-fast
 * error surfacing (Improvement #8).
 */
export function validateAllPrompts(): PromptValidationResult {
  const result: PromptValidationResult = {
    valid: [],
    missing: [],
    parseErrors: [],
  };

  for (const ref of KNOWN_PROMPT_REFS) {
    const filePath = path.join(promptsRoot(), `${ref}.toml`);
    if (!fs.existsSync(filePath)) {
      result.missing.push(ref);
      continue;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      parseToml(raw);
      result.valid.push(ref);
    } catch (err) {
      result.parseErrors.push({
        path: ref,
        error: (err as Error).message,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Improvement #15: Hot-reload file watcher
// ---------------------------------------------------------------------------

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start watching `src/prompts/` for TOML file changes.
 *
 * On any change, the prompt cache is invalidated after a short debounce
 * (300ms) to avoid rapid successive reloads. This eliminates server
 * restarts during prompt-engineering loops.
 *
 * @param onChange — optional callback invoked after cache invalidation
 */
export function startPromptWatcher(
  onChange?: (path: string) => void,
): void {
  if (watcher) return; // Already watching

  const root = promptsRoot();
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".toml")) return;

      // Debounce: wait 300ms after last change before invalidating
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const changedPath = filename.replace(/\.toml$/, "").replace(/\\/g, "/");
        cache.delete(changedPath);
        onChange?.(changedPath);
      }, 300);
    });
  } catch {
    // fs.watch may not be available on all platforms
  }
}

/**
 * Stop the TOML prompt file watcher.
 */
export function stopPromptWatcher(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  watcher?.close();
  watcher = null;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function substituteVars(
  text: string,
  vars: Record<string, string | number>,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`,
  );
}
