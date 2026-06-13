// CreateBranch — validate the proposed name (pure domain), then create it
// (create & switch by default). The route stays thin; validation is testable
// here without a git repo.

import type { BranchAdmin, BranchOpResult } from "../ports/BranchAdmin.ts";
import { validateBranchName } from "../domain/branch-name.ts";

export interface CreateBranchDeps {
  branchAdmin: BranchAdmin;
}

export async function createBranch(
  deps: CreateBranchDeps,
  cwd: string,
  input: { name: string; startPoint?: string | null; checkout?: boolean },
): Promise<BranchOpResult> {
  const verdict = validateBranchName(input.name);
  if (!verdict.ok) return { ok: false, error: verdict.reason };
  return deps.branchAdmin.create(cwd, input.name.trim(), input.startPoint ?? null, {
    checkout: input.checkout ?? true,
  });
}
