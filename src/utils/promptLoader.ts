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
      role: (m.role as string) ?? "user",
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
    const sysMsg = tpl.messages.find((m) => m.role === "system");
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
