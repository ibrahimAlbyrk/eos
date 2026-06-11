// Pure parsers for `git status --porcelain=v1 -z` and `git diff --numstat -z`
// output, kept free of child_process so they can be unit-tested directly.
// Both formats are NUL-delimited token streams where rename entries consume
// extra tokens — a naive split-per-record breaks on them.

import type { ChangedFile } from "../../../contracts/src/http.ts";

// Shared caps for patch payloads: per-file (also the /changes/file endpoint's
// cap) and the total embedded into one /changes?patches=1 response.
export const PATCH_MAX_BYTES = 256 * 1024;
export const PATCHES_TOTAL_MAX_BYTES = 2 * 1024 * 1024;

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

// Git C-quotes paths containing specials ("\303\244bc.txt"); octal escapes are
// UTF-8 BYTES, so decode via a byte buffer, not charcodes.
function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = inner[++i];
    if (next === "n") bytes.push(10);
    else if (next === "t") bytes.push(9);
    else if (next === "r") bytes.push(13);
    else if (next === "\\" || next === '"') bytes.push(next.charCodeAt(0));
    else if (next !== undefined && next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && inner[i + 1] >= "0" && inner[i + 1] <= "7") oct += inner[++i];
      bytes.push(parseInt(oct, 8));
    } else if (next !== undefined) bytes.push(next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

// `+++ b/path` / `--- a/path` value → repo-relative path (null for /dev/null).
function stripDiffPathPrefix(raw: string): string | null {
  const v = unquoteGitPath(raw.replace(/\t$/, ""));
  if (v === "/dev/null") return null;
  return v.replace(/^[ab]\//, "");
}

// Binary sections carry no ---/+++ lines; fall back to the `diff --git a/P b/P`
// header. Paths with spaces make the header ambiguous — resolve by finding the
// split where the a/ and b/ halves are equal (always true outside renames).
function headerPath(header: string | undefined): string | null {
  if (!header?.startsWith("diff --git ")) return null;
  const rest = header.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    if (end === -1) return null;
    return stripDiffPathPrefix(rest.slice(0, end + 1));
  }
  for (let sp = rest.indexOf(" b/"); sp !== -1; sp = rest.indexOf(" b/", sp + 1)) {
    const aSide = rest.slice(0, sp);
    const bSide = rest.slice(sp + 1);
    if (aSide.startsWith("a/") && aSide.slice(2) === bSide.slice(2)) return bSide.slice(2);
  }
  return null;
}

// Resolve a section's file path from its unambiguous per-file lines, scanned
// only up to the first hunk marker — an added line starting with "++ " would
// otherwise fake a `+++ ` header. Deletions (`+++ /dev/null`) key on the old
// path, matching ChangedFile.path for status D.
function sectionPath(section: string[]): string | null {
  let renameTo: string | null = null;
  let oldP: string | null = null;
  let newP: string | null = null;
  for (const l of section) {
    if (l.startsWith("@@")) break;
    if (l.startsWith("rename to ")) renameTo = unquoteGitPath(l.slice("rename to ".length));
    else if (l.startsWith("+++ ")) newP = stripDiffPathPrefix(l.slice(4));
    else if (l.startsWith("--- ")) oldP = stripDiffPathPrefix(l.slice(4));
  }
  return renameTo ?? newP ?? oldP ?? headerPath(section[0]);
}

// Split one whole-tree `git diff` into per-file patch texts keyed by the
// file's path as the changes listing reports it. Sections whose path can't be
// resolved are dropped — those files just keep lazy per-file loading.
export function splitUnifiedDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const lines = diff.split("\n");
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const section = lines.slice(start, end);
    // The split leaves a trailing "" on the last section (terminal newline) —
    // drop it so every section ends with exactly one newline.
    while (section.length && section[section.length - 1] === "") section.pop();
    const path = sectionPath(section);
    if (path) out.set(path, section.join("\n") + "\n");
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) {
      flush(i);
      start = i;
    }
  }
  flush(lines.length);
  return out;
}

const BINARY_SECTION = /^(Binary files .* differ|GIT binary patch)$/m;

// Embed per-file patches (split from ONE whole-tree diff) into the changes
// listing — same shape as the per-file endpoint so consumers can reuse its
// handling. Untracked files have no tree-diff section and stay lazy. A file
// bigger than perFileMax embeds truncated (mirroring GET /changes/file); a
// file that merely overflows the remaining TOTAL budget is skipped entirely,
// so the lazy fetch can still deliver it whole.
export function attachPatches(
  files: ChangedFile[],
  fullDiff: string,
  perFileMax: number,
  totalMax: number,
): void {
  const sections = splitUnifiedDiff(fullDiff);
  let budget = totalMax;
  for (const f of files) {
    if (f.untracked) continue;
    const raw = sections.get(f.path);
    if (raw === undefined) continue;
    if (BINARY_SECTION.test(raw)) {
      f.patch = "";
      f.binary = true;
      f.truncated = false;
      continue;
    }
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > perFileMax) {
      if (budget < perFileMax) continue;
      const t = truncatePatch(raw, perFileMax);
      f.patch = t.patch;
      f.binary = false;
      f.truncated = true;
      budget -= perFileMax;
    } else if (bytes > budget) {
      continue;
    } else {
      f.patch = raw;
      f.binary = false;
      f.truncated = false;
      budget -= bytes;
    }
  }
}
