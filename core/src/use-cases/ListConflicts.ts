// ListConflicts — the unmerged files in a working tree, each classified into a
// semantic kind. Pure orchestration over GitInfo + the domain classifier.

import type { GitInfo } from "../ports/GitInfo.ts";
import type { ConflictListResponse } from "../../../contracts/src/http.ts";
import { classifyConflict } from "../domain/conflict.ts";

export interface ListConflictsDeps {
  git: GitInfo;
}

export async function listConflicts(deps: ListConflictsDeps, cwd: string): Promise<ConflictListResponse> {
  const entries = await deps.git.conflictList(cwd);
  return {
    files: entries.map((e) => ({ path: e.path, xy: e.xy, kind: classifyConflict(e.xy) })),
  };
}
