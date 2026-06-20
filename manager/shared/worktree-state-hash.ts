// A stable hash of a worker's current change-set, the no-progress signal. Hashes
// the full diff (tracked content edits, base = the stable fork point) PLUS a
// projection of changedFiles (which surfaces UNTRACKED files the diff omits, and
// the file set). Identical working tree ⇒ identical hash. Returns "" when there
// is no worktree to measure (the gate then skips no-progress for that worker).

import { createHash } from "node:crypto";
import type { GitInfo } from "../../core/src/ports/GitInfo.ts";

export async function worktreeStateHash(
  git: Pick<GitInfo, "fullDiff" | "changedFiles">,
  input: { worktreeDir?: string; forkBaseSha?: string },
): Promise<string> {
  if (!input.worktreeDir) return "";
  const base = input.forkBaseSha;
  // fullDiff is null on a huge diff / no repo — fall back to the changedFiles
  // projection alone (still captures the file set + untracked adds).
  const diff = await git.fullDiff(input.worktreeDir, base).catch(() => null);
  const changed = await git.changedFiles(input.worktreeDir, base).catch(() => []);
  const fileSet = JSON.stringify(changed.map((f) => [f.path, f.status, f.untracked]).sort());
  return createHash("sha256").update(`${diff ?? ""} ${fileSet}`).digest("hex");
}
