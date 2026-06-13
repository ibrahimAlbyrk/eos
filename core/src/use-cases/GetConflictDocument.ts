// GetConflictDocument — the parsed, hunk-structured view of ONE conflicted
// file for the resolver UI. Content conflicts are parsed into segments; add/
// delete conflicts carry no markers (style "none" → whole-file choice).
// Returns null when the path is no longer conflicted (resolved underneath).

import type { GitInfo } from "../ports/GitInfo.ts";
import type { ConflictDocumentResponse } from "../../../contracts/src/http.ts";
import { classifyConflict, parseConflictMarkers, fingerprintOf } from "../domain/conflict.ts";

export interface GetConflictDocumentDeps {
  git: GitInfo;
}

export async function getConflictDocument(
  deps: GetConflictDocumentDeps,
  cwd: string,
  path: string,
): Promise<ConflictDocumentResponse | null> {
  const entry = (await deps.git.conflictList(cwd)).find((e) => e.path === path);
  if (!entry) return null;

  const kind = classifyConflict(entry.xy);
  if (kind !== "content") {
    return { path, kind, style: "none", segments: [], conflictCount: 0, fingerprint: "" };
  }

  const content = await deps.git.conflictFileContent(cwd, path);
  const doc = parseConflictMarkers(content);
  return {
    path,
    kind,
    style: doc.style,
    segments: doc.segments,
    conflictCount: doc.conflictCount,
    fingerprint: fingerprintOf(content),
  };
}
