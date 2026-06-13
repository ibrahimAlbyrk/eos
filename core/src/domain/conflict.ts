// conflict.ts — pure merge-conflict parsing/assembly. No Node imports.
//
// The conflicted WORKING TREE is the source of truth: a `git merge`/`rebase`/
// `cherry-pick` left in-file markers (and stage 1/2/3 index entries). We parse
// the markers into hunks the UI resolves per-hunk (ours / theirs / hand-edited),
// then reassemble the chosen content. Both parse and assemble run server-side
// (one source of truth) so the web never duplicates the parser.

import type { ConflictKind, ConflictSegment } from "../../../contracts/src/http.ts";

// Conflict markers are exactly 7 chars; the open/close/base markers may carry a
// label after a space (`<<<<<<< HEAD`), the separator never does. `\r?` tolerates
// CRLF files. `{7}` plus the `(?: …)?\r?$` tail rejects 8+ runs that appear in
// content. The separator is matched bare (`={7}`) — matching git's own output —
// so a stray label-bearing `=======` line never hijacks a hunk.
const OURS_RE = /^<{7}(?: .*)?\r?$/;
const BASE_RE = /^\|{7}(?: .*)?\r?$/;
const SEP_RE = /^={7}\r?$/;
const THEIRS_RE = /^>{7}(?: .*)?\r?$/;

// Unmerged porcelain combos per git docs: DD AU UD UA DU AA UU. Single source so
// conflictCount (the chip) and conflictList (the resolver) can never disagree.
export function isUnmergedCode(xy: string): boolean {
  return (
    xy === "DD" || xy === "AU" || xy === "UD" ||
    xy === "UA" || xy === "DU" || xy === "AA" || xy === "UU"
  );
}

// XY → semantic kind. `content` (both modified / both added) is hunk-resolvable;
// the rest are a whole-file keep/remove choice (no in-file markers).
export function classifyConflict(xy: string): ConflictKind {
  switch (xy) {
    case "UU":
    case "AA": return "content";
    case "DU": return "ours-deleted";
    case "UD": return "theirs-deleted";
    case "AU": return "ours-added";
    case "UA": return "theirs-added";
    case "DD": return "both-deleted";
    default: return "content";
  }
}

export interface ConflictDocument {
  segments: ConflictSegment[];
  style: "merge" | "diff3" | "unparseable";
  conflictCount: number;
}

export type HunkResolutionInput =
  | { id: number; choice: "ours" | "theirs" }
  | { id: number; manual: string[] };

const UNPARSEABLE: ConflictDocument = { segments: [], style: "unparseable", conflictCount: 0 };

// Splits a conflicted file into ordered context / conflict segments. Marker
// lines are dropped; content lines are kept verbatim (incl. any trailing `\r`),
// so assembleResolution() round-trips line endings and the final newline.
// Returns the `unparseable` document on any malformed/nested marker run — the
// caller then falls back to a whole-file choice or the git-agent path.
export function parseConflictMarkers(content: string): ConflictDocument {
  const lines = content.split("\n");
  const segments: ConflictSegment[] = [];
  let ctx: string[] = [];
  let style: "merge" | "diff3" = "merge";
  let id = 0;
  let i = 0;

  const flushCtx = (): void => {
    if (ctx.length) { segments.push({ kind: "context", lines: ctx }); ctx = []; }
  };

  while (i < lines.length) {
    if (!OURS_RE.test(lines[i])) { ctx.push(lines[i++]); continue; }

    // Open marker — collect ours up to the base/separator.
    i++;
    const ours: string[] = [];
    while (i < lines.length && !BASE_RE.test(lines[i]) && !SEP_RE.test(lines[i]) && !THEIRS_RE.test(lines[i]) && !OURS_RE.test(lines[i])) {
      ours.push(lines[i++]);
    }

    // Optional base section (diff3 / zdiff3 conflict style).
    let base: string[] | null = null;
    if (i < lines.length && BASE_RE.test(lines[i])) {
      style = "diff3";
      base = [];
      i++;
      while (i < lines.length && !SEP_RE.test(lines[i]) && !THEIRS_RE.test(lines[i]) && !OURS_RE.test(lines[i])) {
        base.push(lines[i++]);
      }
    }

    if (i >= lines.length || !SEP_RE.test(lines[i])) return UNPARSEABLE;
    i++; // skip =======

    const theirs: string[] = [];
    while (i < lines.length && !THEIRS_RE.test(lines[i]) && !SEP_RE.test(lines[i]) && !OURS_RE.test(lines[i])) {
      theirs.push(lines[i++]);
    }

    if (i >= lines.length || !THEIRS_RE.test(lines[i])) return UNPARSEABLE;
    i++; // skip >>>>>>>

    flushCtx();
    segments.push({ kind: "conflict", id: id++, ours, base, theirs });
  }

  flushCtx();
  // A `content` file with no parseable hunks is itself a malformed state.
  if (id === 0) return UNPARSEABLE;
  return { segments, style, conflictCount: id };
}

// Reassembles the resolved file: context verbatim, each conflict replaced by its
// chosen side (or hand-edited lines). Hunks with no resolution are reported in
// `unresolved` and skipped — the caller must NOT write while any remain.
export function assembleResolution(
  doc: ConflictDocument,
  resolutions: Map<number, HunkResolutionInput>,
): { content: string; unresolved: number[] } {
  const out: string[] = [];
  const unresolved: number[] = [];
  for (const seg of doc.segments) {
    if (seg.kind === "context") { out.push(...seg.lines); continue; }
    const r = resolutions.get(seg.id);
    if (!r) { unresolved.push(seg.id); continue; }
    if ("manual" in r) out.push(...r.manual);
    else out.push(...(r.choice === "ours" ? seg.ours : seg.theirs));
  }
  return { content: out.join("\n"), unresolved };
}

// Cheap deterministic content hash (FNV-1a + length) for optimistic
// concurrency: the resolve request echoes the fingerprint the document was
// chosen against, and the server rejects the apply if the file changed since.
export function fingerprintOf(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ":" + content.length.toString(16);
}
