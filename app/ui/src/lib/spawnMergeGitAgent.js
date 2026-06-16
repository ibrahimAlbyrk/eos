import { gitAgentName } from "./gitAgentName.js";

// Spawn a git agent in the worker's base checkout that merges its worktree
// branch and resolves conflicts, then selects it. Shared by the Changes panel
// and the orchestrator hub rows so the conflict escalation behaves identically.
export async function spawnMergeGitAgent(worker, live, ui) {
  if (!worker?.worktree_from || !worker?.branch) return;
  const prompt = `Merge branch ${worker.branch} into the current branch. Context: ${worker.branch} is a live Eos agent worktree branch — never check it out or delete it. Resolve any conflicts preserving both sides' intent.`;
  const r = await live.spawnGitAgent({
    cwd: worker.worktree_from,
    prompt,
    name: gitAgentName(worker.worktree_from, worker.branch, `merge ${worker.branch}`),
  });
  if (r?.ok && r.body?.id) ui.setSelectedId(r.body.id);
}
