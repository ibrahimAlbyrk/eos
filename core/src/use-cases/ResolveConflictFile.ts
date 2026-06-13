// ResolveConflictFile — applies the operator's resolution for ONE file. Content
// conflicts re-parse against the client's fingerprint (optimistic concurrency),
// assemble the chosen sides, and write only when every hunk is resolved. Add/
// delete conflicts apply the whole-file side. Either way the file is staged and
// `remaining` reports how many conflicted files are left in the tree.

import type { GitInfo } from "../ports/GitInfo.ts";
import type { ConflictResolution } from "../ports/ConflictResolution.ts";
import type { ResolveConflictRequest, ResolveConflictResponse } from "../../../contracts/src/http.ts";
import {
  assembleResolution,
  classifyConflict,
  fingerprintOf,
  parseConflictMarkers,
  type HunkResolutionInput,
} from "../domain/conflict.ts";

export interface ResolveConflictDeps {
  git: GitInfo;
  conflicts: ConflictResolution;
}

export async function resolveConflictFile(
  deps: ResolveConflictDeps,
  cwd: string,
  req: ResolveConflictRequest,
): Promise<ResolveConflictResponse> {
  const entries = await deps.git.conflictList(cwd);
  const entry = entries.find((e) => e.path === req.path);
  if (!entry) {
    return { ok: false, staged: false, unresolved: [], remaining: entries.length, reason: "not-conflicted" };
  }

  const kind = classifyConflict(entry.xy);

  // Add/delete conflicts have no markers — apply the whole-file side choice.
  if (kind !== "content") {
    if (req.side !== "ours" && req.side !== "theirs") {
      return { ok: false, staged: false, unresolved: [], remaining: entries.length, reason: "incomplete" };
    }
    await deps.conflicts.takeSide(cwd, req.path, req.side, kind);
    return { ok: true, staged: true, unresolved: [], remaining: await deps.git.conflictCount(cwd) };
  }

  // Content conflict — re-read + re-parse so the apply runs against the current
  // file. A fingerprint mismatch means it changed since the document was shown.
  const content = await deps.git.conflictFileContent(cwd, req.path);
  if (req.fingerprint && req.fingerprint !== fingerprintOf(content)) {
    return { ok: false, staged: false, unresolved: [], remaining: entries.length, reason: "stale" };
  }
  const doc = parseConflictMarkers(content);
  if (doc.style === "unparseable") {
    return { ok: false, staged: false, unresolved: [], remaining: entries.length, reason: "unparseable" };
  }

  const map = new Map<number, HunkResolutionInput>();
  for (const r of req.resolutions ?? []) map.set(r.id, r);
  const { content: resolved, unresolved } = assembleResolution(doc, map);
  if (unresolved.length > 0) {
    return { ok: false, staged: false, unresolved, remaining: entries.length, reason: "incomplete" };
  }

  await deps.conflicts.writeResolved(cwd, req.path, resolved);
  return { ok: true, staged: true, unresolved: [], remaining: await deps.git.conflictCount(cwd) };
}
