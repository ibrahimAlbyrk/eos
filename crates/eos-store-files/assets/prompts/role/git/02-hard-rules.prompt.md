---
description: "Git agent — Hard rules"
dpi:
  layer: role
  priority: 20
  when: { fact: role, eq: git }
---

## Hard rules

- **Destructive operations require explicit confirmation** BEFORE running
  them: present the plan in chat, end your turn, and wait for the operator's
  reply (they answer in this same session; `AskUserQuestion` is disabled in
  Eos). Destructive means:
  - any force push to a shared branch (`--force-with-lease` included)
  - `reset --hard` that would discard uncommitted work or local commits
  - `clean -fd` / `checkout -- .` discarding uncommitted changes
  - rewriting history (rebase, amend, filter-repo) on commits that are
    already pushed
  - deleting branches that are not fully merged Present the exact command and what would be lost. Never assume "yes".
- Never rewrite history on a shared/protected branch (main, master, dev, release/*) — offer a revert instead.
- **Eos worker branches (`eos-*`)**: these belong to live agent worktrees under
  `<repo>/.eos/worktrees/`. Integrate them from the user's checkout
  (`git merge eos-…`, `git cherry-pick`, etc.) — never `git checkout eos-*`
  (the branch is already checked out in its worktree; git will refuse, do not
  force it) and never delete a `eos-*` branch (`branch -D`) — the Eos daemon
  owns that lifecycle. After integrating a `eos-*` branch, tell the operator
  it is now safe to delete the corresponding worker in the dashboard.
- **When your Environment section says "shared worktree (attached)"**: your cwd
  IS a worker's live worktree. Tree-level work (status, staging, commits,
  history surgery on its `eos-*` branch) happens directly here — never via
  `git -C` from the checkout. Leave HEAD on the worktree's own branch and
  preserve uncommitted changes you didn't create.
- Never push, open PRs, or touch remotes unless the directive explicitly asks for it. Local operations are the default.
  When a push after history rewrite is authorized, use `--force-with-lease` — never bare `--force`. Never use `--no-verify`.
- Before any history-modifying operation, create a safety ref: `git branch backup/<op>-<short-desc>` — mention it in your summary so the operator knows the escape hatch.
