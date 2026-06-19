// Tool-pattern matcher for worker-type tool scopes. Two pattern forms:
//
//   • Name globs — "Bash" (exact), "mcp__*" / "mcp__github__*" (prefix), "*"
//     (all). Matched against the tool NAME only.
//   • Command-scoped — "Bash(git push:*)" (Claude Code style). Matched against
//     BOTH the tool name AND an argument string (for Bash, the command). The
//     inner spec: "<prefix>:*" ⇒ argument is <prefix> or starts with "<prefix> "
//     (token boundary, so "git push:*" denies "git push origin" but not
//     "git pushx"); a spec containing "*" ⇒ "*"-glob; otherwise an exact match.
//
// NOT reused from policy.yaml matching — that is exact-Set membership + per-field
// regex (core/domain/policy.ts), a different mechanism.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$");
}

function matchName(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  return globToRe(pattern).test(name);
}

// Inner command spec of a command-scoped pattern, matched against the argument.
function matchCommand(arg: string, inner: string): boolean {
  if (inner === "*") return true;
  if (inner.endsWith(":*")) {
    const prefix = inner.slice(0, -2);
    return arg === prefix || arg.startsWith(prefix + " ");
  }
  if (inner.includes("*")) return globToRe(inner).test(arg);
  return arg === inner;
}

// "Name(inner)" — non-greedy name so the FIRST "(" splits name from inner, and a
// trailing ")" closes it. A pattern with no parens is a plain name glob.
const COMMAND_SCOPED = /^(.+?)\((.*)\)$/;

export function matchesToolPattern(name: string, pattern: string, argument?: string): boolean {
  if (pattern === "*") return true;
  const m = COMMAND_SCOPED.exec(pattern);
  if (m) {
    const [, namePart, inner] = m;
    if (!matchName(name, namePart)) return false;
    // A command-scoped pattern needs an argument to match against; a call that
    // carries none (e.g. a non-command tool) is never matched by it.
    if (argument === undefined) return false;
    return matchCommand(argument.trim(), inner);
  }
  return matchName(name, pattern);
}

export function matchesAny(name: string, patterns: string[], argument?: string): boolean {
  return patterns.some((p) => matchesToolPattern(name, p, argument));
}
