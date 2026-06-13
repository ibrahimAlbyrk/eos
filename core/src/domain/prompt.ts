// Value objects for the prompt system. Pure data; no I/O. RawPrompt crosses the
// PromptSource port (infra parses YAML → frontmatter object); ParsedPrompt is
// the validated + compiled form the registry hands to the renderer.

import { DpiMetaSchema } from "../../../contracts/src/prompt.ts";
import type { DpiMeta, PromptFrontmatter } from "../../../contracts/src/prompt.ts";

export type VariableValue = string | number | boolean | string[] | null | undefined;
export type VariableScope = Record<string, VariableValue>;

// One prompt as read off disk: id + the raw (YAML-parsed, unvalidated)
// frontmatter object + the markdown body.
export interface RawPrompt {
  id: string;
  frontmatter: unknown;
  body: string;
  sourcePath?: string;
}

// The compiled template body — a tiny AST. `text` is literal output; `interp`
// substitutes a (possibly dotted) variable path; `cond` renders its body when
// the path is truthy (negate flips it, for {{#unless}}).
export type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "interp"; path: string }
  | { kind: "cond"; path: string; negate: boolean; body: TemplateNode[] };

export interface ParsedPrompt {
  id: string;
  frontmatter: PromptFrontmatter;
  body: string;
  nodes: TemplateNode[];
  // Top-level variable names referenced in the body (interp + cond paths).
  referenced: string[];
  // Non-fatal authoring issues (e.g. a referenced var with no declaration).
  warnings: string[];
}

// A fragment is a parsed prompt that carries DPI metadata (the `dpi:` block).
// Layer 2 composes these; Layer 1 is oblivious to the extra field.
export interface Fragment {
  prompt: ParsedPrompt;
  dpi: DpiMeta;
}

// Layer 2 boundary: a parsed prompt becomes a Fragment only if its opaque `dpi`
// block validates against DpiMetaSchema. Invalid/absent dpi → not a fragment
// (the prompt is still a usable Layer-1 template).
export function toFragment(p: ParsedPrompt): Fragment | null {
  if (p.frontmatter.dpi === undefined || p.frontmatter.dpi === null) return null;
  const parsed = DpiMetaSchema.safeParse(p.frontmatter.dpi);
  return parsed.success ? { prompt: p, dpi: parsed.data } : null;
}

// Shared truthiness rule for the template engine (Layer 1) and the condition
// evaluator (Layer 2): false, 0, "", null, undefined, and [] are falsy.
export function isTruthy(v: unknown): boolean {
  if (v == null || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
