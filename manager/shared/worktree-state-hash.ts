// A stable hash of a worker's current change-set, the no-progress signal. Hashes
// the full diff (tracked content edits, base = the stable fork point) PLUS a
// projection of changedFiles (which surfaces UNTRACKED files the diff omits, and
// the file set). Identical working tree ⇒ identical hash. A worktree worker is
// measured in its worktree; a cwd worker (no worktree) falls back to its checkout
// dir so it still gets a no-progress signal. Returns "" only when there is no
// directory at all to measure (the gate then skips no-progress for that worker).

import { createHash } from "node:crypto";
import type { GitInfo } from "../../core/src/ports/GitInfo.ts";

export async function worktreeStateHash(
  git: Pick<GitInfo, "fullDiff" | "changedFiles">,
  input: { worktreeDir?: string; cwd?: string; forkBaseSha?: string },
): Promise<string> {
  const dir = input.worktreeDir ?? input.cwd;
  if (!dir) return "";
  const base = input.forkBaseSha;
  // fullDiff is null on a huge diff / no repo — fall back to the changedFiles
  // projection alone (still captures the file set + untracked adds).
  const diff = await git.fullDiff(dir, base).catch(() => null);
  const changed = await git.changedFiles(dir, base).catch(() => []);
  const fileSet = JSON.stringify(changed.map((f) => [f.path, f.status, f.untracked]).sort());
  return createHash("sha256").update(`${diff ?? ""} ${fileSet}`).digest("hex");
}
