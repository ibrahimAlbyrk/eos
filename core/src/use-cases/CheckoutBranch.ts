// CheckoutBranch — checkout a branch by its picker label. A remote-tracking
// label ("origin/x") is stripped to its short name so `git checkout x` DWIM-
// creates a local tracking branch instead of landing on a detached HEAD; a
// local label passes through untouched.
//
// Returns a structured result instead of throwing: the common "uncommitted
// changes block the switch" failure comes back as { dirty: true } so the UI can
// offer "Stash & switch" rather than dumping the raw multi-line git error. With
// opts.stash the changes are stashed first (that's what the UI's Stash & switch
// calls). Any other failure returns a cleaned single-line message.

import type { GitInfo } from "../ports/GitInfo.ts";
import { stripRemotePrefix } from "../domain/remote-ref.ts";

export interface CheckoutBranchDeps {
  git: GitInfo;
}

export interface CheckoutBranchResult {
  ok: boolean;
  dirty?: boolean;   // local changes block the switch — offer Stash & switch
  error?: string;
}

// `git checkout` rejects with a "Command failed: git -C …\nerror: …" message;
// surface only the meaningful error/fatal line, not the command echo.
function cleanGitError(msg: string): string {
  const line = msg.split("\n").map((s) => s.trim()).find((s) => /^(error|fatal):/i.test(s));
  return (line ?? msg.split("\n")[0] ?? "Checkout failed").replace(/^(error|fatal):\s*/i, "");
}

function isDirtyBlock(msg: string): boolean {
  return /would be overwritten|commit your changes or stash|please commit/i.test(msg);
}

export async function checkoutBranch(
  deps: CheckoutBranchDeps,
  cwd: string,
  label: string,
  opts: { stash?: boolean } = {},
): Promise<CheckoutBranchResult> {
  const remotes = await deps.git.remotes(cwd);
  const target = stripRemotePrefix(label, remotes);

  if (opts.stash) {
    try {
      await deps.git.stashPush(cwd);
    } catch (e) {
      return { ok: false, error: cleanGitError(e instanceof Error ? e.message : String(e)) };
    }
  }

  try {
    await deps.git.checkout(cwd, target);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!opts.stash && isDirtyBlock(msg)) return { ok: false, dirty: true };
    return { ok: false, error: cleanGitError(msg) };
  }
}
