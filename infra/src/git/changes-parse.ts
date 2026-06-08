// Pure parsers for `git status --porcelain=v1 -z` and `git diff --numstat -z`
// output, kept free of child_process so they can be unit-tested directly.
// Both formats are NUL-delimited token streams where rename entries consume
// extra tokens — a naive split-per-record breaks on them.

import type { ChangedFile } from "../../../contracts/src/http.ts";

export interface PorcelainEntry {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
}

// `git status --porcelain=v1 -z -uall`: each record is "XY <path>" followed,
// for renames/copies (X is R or C), by ONE extra NUL-separated token: the
// ORIGINAL path.
export function parsePorcelainZ(out: string): PorcelainEntry[] {
  const tokens = out.split("\0").filter((t) => t.length > 0);
  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (tok.length < 4 || tok[2] !== " ") continue;
    const x = tok[0];
    const y = tok[1];
    const path = tok.slice(3);
    const entry: PorcelainEntry = { path, x, y };
    if (x === "R" || x === "C") entry.oldPath = tokens[i++];
    entries.push(entry);
  }
  return entries;
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  insertions: number | null;
  deletions: number | null;
}

// `git diff --numstat -z HEAD`: records are "ins\tdel\tpath" NUL, except
// renames where the path after the second tab is EMPTY and the next two NUL
// tokens are oldpath, newpath. Binary files report "-" for both counts.
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split("\0");
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (!tok) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(tok);
    if (!m) continue;
    const insertions = m[1] === "-" ? null : parseInt(m[1], 10);
    const deletions = m[2] === "-" ? null : parseInt(m[2], 10);
    if (m[3] === "") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (path === undefined) break;
      entries.push({ path, oldPath, insertions, deletions });
    } else {
      entries.push({ path: m[3], insertions, deletions });
    }
  }
  return entries;
}

export interface NameStatusEntry {
  path: string;
  oldPath?: string;
  status: ChangedFile["status"];
}

// `git diff --name-status -z <base>`: records are "<letter>\0path\0"; renames
// and copies are "R###"/"C###" followed by TWO paths (old, new). Typechange
// (T) collapses to M; copies render as A with the source as oldPath.
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split("\0").filter((t) => t.length > 0);
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!/^[MADRCT]/.test(code)) continue;
    if (code[0] === "R" || code[0] === "C") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (path === undefined) break;
      entries.push({ path, oldPath, status: code[0] === "R" ? "R" : "A" });
    } else {
      const path = tokens[i++];
      if (path === undefined) break;
      const status = code[0] === "T" ? "M" : (code[0] as ChangedFile["status"]);
      entries.push({ path, status });
    }
  }
  return entries;
}

// Base-aware listing: `git diff <base>` (base vs working tree) already covers
// committed-after-fork AND uncommitted tracked changes — porcelain only
// contributes untracked (??) files on top.
export function mergeChangesWithBase(
  nameStatus: NameStatusEntry[],
  porcelain: PorcelainEntry[],
  numstat: NumstatEntry[],
): ChangedFile[] {
  const counts = new Map(numstat.map((n) => [n.path, n]));
  const files: ChangedFile[] = [];
  for (const e of nameStatus) {
    if (e.path.startsWith(".eos/")) continue;
    const n = counts.get(e.path);
    const file: ChangedFile = {
      path: e.path,
      status: e.status,
      untracked: false,
      insertions: n?.insertions ?? null,
      deletions: n?.deletions ?? null,
    };
    if (e.oldPath) file.oldPath = e.oldPath;
    files.push(file);
  }
  const seen = new Set(files.map((f) => f.path));
  for (const e of porcelain) {
    if (e.x + e.y !== "??" || seen.has(e.path) || e.path.startsWith(".eos/")) continue;
    files.push({ path: e.path, status: "A", untracked: true, insertions: null, deletions: null });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function statusOf(e: PorcelainEntry): { status: ChangedFile["status"]; untracked: boolean } {
  const xy = e.x + e.y;
  if (xy === "??") return { status: "A", untracked: true };
  if (e.x === "R" || e.y === "R") return { status: "R", untracked: false };
  // Unmerged combos collapse to M — the conflicts chip already covers them.
  if (xy === "DD" || xy === "AU" || xy === "UD" || xy === "UA" || xy === "DU" || xy === "AA" || xy === "UU") {
    return { status: "M", untracked: false };
  }
  if (e.x === "D" || e.y === "D") return { status: "D", untracked: false };
  if (e.x === "A") return { status: "A", untracked: false };
  return { status: "M", untracked: false };
}

// Porcelain is the authority on WHAT changed (it sees untracked files);
// numstat supplies per-file counts for tracked changes.
export function mergeChanges(porcelain: PorcelainEntry[], numstat: NumstatEntry[]): ChangedFile[] {
  const counts = new Map(numstat.map((n) => [n.path, n]));
  const files: ChangedFile[] = [];
  for (const e of porcelain) {
    // Worktree dirs live under <repo>/.eos/worktrees — noise when the
    // pre-enrichment fallback diffs the repo root.
    if (e.path.startsWith(".eos/")) continue;
    const { status, untracked } = statusOf(e);
    const n = counts.get(e.path);
    const file: ChangedFile = {
      path: e.path,
      status,
      untracked,
      insertions: n?.insertions ?? null,
      deletions: n?.deletions ?? null,
    };
    if (e.oldPath) file.oldPath = e.oldPath;
    files.push(file);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Cut at the last complete line within maxBytes (byte-accurate for UTF-8).
export function truncatePatch(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  const buf = Buffer.from(patch, "utf8");
  if (buf.length <= maxBytes) return { patch, truncated: false };
  const slice = buf.subarray(0, maxBytes).toString("utf8");
  const cut = slice.lastIndexOf("\n");
  return { patch: cut > 0 ? slice.slice(0, cut + 1) : slice, truncated: true };
}
