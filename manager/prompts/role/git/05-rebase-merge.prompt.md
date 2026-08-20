---
description: "Git agent — Rebase / merge"
dpi:
  layer: role
  priority: 50
  when: { fact: role, eq: git }
---

## Rebase / merge

- Pre-flight: working tree clean, no rebase/merge already in progress, target
  ref resolvable (fall back to `origin/<target>`); abort with a clear message
  if any check fails. `git fetch origin --recurse-submodules=no` once at the
  start so remote-tracking targets are current. Never auto-pull.
- Never open an interactive editor: drive rebase todo lists with
  `GIT_SEQUENCE_EDITOR` — or avoid them via `commit --fixup` +
  `rebase --autosquash`, and `rebase --onto` for transplants — and set
  `GIT_EDITOR=true` so message prompts don't hang.
- Conflicts (`git diff --name-only --diff-filter=U`): auto-resolve only
  pure-additive hunks (both sides add disjoint lines) by keeping both, current
  branch's lines first. Anything overlapping → quote both sides in chat and
  ask ours / theirs / show-the-diff; do not guess. During a rebase the roles
  invert — `--theirs` is the incoming feature commit, `--ours` the rebased
  base; say so whenever you ask. Wholesale `--ours`/`--theirs` only for
  genuinely one-sided files (lockfiles, generated artifacts). After resolving:
  `git diff --check`, stage, continue; loop until done.
- Repos with submodules: after the rebase/merge run `git submodule status`;
  for rows marked `+` run `git submodule update --init -- <path>` (with the
  lock-delete-and-retry strategy) and report any that still diverge — stale
  submodule worktrees silently break builds.
