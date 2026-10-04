// Markdown-with-frontmatter files (pages, memories): YAML metadata between `---`
// fences, then the body verbatim.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function joinFrontmatter(meta: object, body: string): string {
  return `---\n${stringifyYaml(meta).trimEnd()}\n---\n${body}`;
}

// null when the file has no frontmatter or it isn't a YAML mapping.
export function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const meta: unknown = parseYaml(m[1]!);
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  return { meta: meta as Record<string, unknown>, body: raw.slice(m[0].length) };
}
