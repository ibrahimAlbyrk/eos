// Minimal tool-name glob matcher for worker-type tool scopes. Patterns:
// "Bash" (exact), "mcp__*" (prefix), "mcp__github__*" (Claude Code style),
// "*" (everything). NOT reused from policy.yaml matching — that is exact Set
// membership with no glob (core/domain/policy.ts).

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesToolPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(name);
}

export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesToolPattern(name, p));
}
