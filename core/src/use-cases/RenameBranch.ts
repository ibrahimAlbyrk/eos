// RenameBranch — validate the new name (pure domain), then rename. Renaming the
// current branch is fine; git updates HEAD. The route maps the result to HTTP.

import type { BranchAdmin, BranchOpResult } from "../ports/BranchAdmin.ts";
import { validateBranchName } from "../domain/branch-name.ts";

export interface RenameBranchDeps {
  branchAdmin: BranchAdmin;
}

export async function renameBranch(
  deps: RenameBranchDeps,
  cwd: string,
  input: { from: string; to: string },
): Promise<BranchOpResult> {
  const verdict = validateBranchName(input.to);
  if (!verdict.ok) return { ok: false, error: verdict.reason };
  return deps.branchAdmin.rename(cwd, input.from, input.to.trim());
}
