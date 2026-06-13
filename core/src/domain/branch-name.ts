// Pure validation of a proposed git branch name against the subset of
// `git check-ref-format` rules that matter for a branch. Zero I/O — the UI and
// the create/rename use-cases share this one source of truth so the client can
// reject bad names before a round-trip and the server stays authoritative.

export interface BranchNameVerdict {
  ok: boolean;
  reason?: string;
}

export function validateBranchName(name: string): BranchNameVerdict {
  const n = name.trim();
  if (!n) return { ok: false, reason: "Branch name is empty." };
  if (n.length > 255) return { ok: false, reason: "Branch name is too long." };
  if (n === "@") return { ok: false, reason: "Branch name cannot be '@'." };
  if (n.startsWith("/") || n.endsWith("/")) return { ok: false, reason: "Cannot start or end with '/'." };
  if (n.startsWith(".") || n.endsWith(".")) return { ok: false, reason: "Cannot start or end with '.'." };
  if (n.endsWith(".lock")) return { ok: false, reason: "Cannot end with '.lock'." };
  if (n.includes("..")) return { ok: false, reason: "Cannot contain '..'." };
  if (n.includes("//")) return { ok: false, reason: "Cannot contain '//'." };
  if (n.includes("@{")) return { ok: false, reason: "Cannot contain '@{'." };
  // Forbidden special characters (git ref rules): space and ~ ^ : ? * [ \.
  if (/[ ~^:?*[\\]/.test(n)) {
    return { ok: false, reason: "Contains a forbidden character (space or one of ~ ^ : ? * [ \\)." };
  }
  // ASCII control characters (including DEL) are also disallowed in ref names.
  for (let i = 0; i < n.length; i++) {
    const code = n.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { ok: false, reason: "Contains a control character." };
  }
  return { ok: true };
}
