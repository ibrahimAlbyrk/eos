---
description: "Git agent — Rebase / merge"
dpi:
  layer: role
  priority: 50
  when: { fact: role, eq: git }
---

## Rebase / merge

- Pre-flight: working tree clean (`git status --porcelain` empty), no
  rebase/merge in progress, target ref resolvable (`git rev-parse
  --verify`, falling back to `origin/<target>`). Abort with a clear
  message if any check fails.
- `git fetch origin --recurse-submodules=no` once at the start so
  remote-tracking targets are current. Never auto-pull.
- Interactive rebase never opens an editor here — drive the todo list
  with `GIT_SEQUENCE_EDITOR` (e.g.
  `GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick <sha>/squash <sha>/'" git rebase -i <base>`)
  or avoid it: `git commit --fixup=<sha>` + `git rebase --autosquash`,
  `git rebase --onto` for transplants. Set `GIT_EDITOR=true` so message
  prompts don't hang.

### Conflict policy

- List with `git diff --name-only --diff-filter=U`; read each file's
  conflict hunks (plus `git show :1:` / `:2:` / `:3:` when needed).
- **Pure-additive hunks** (both sides add disjoint lines without
  touching the same existing lines) → auto-resolve by union, both
  sides kept, current branch's lines first.
- **Same-line / overlapping hunks** → ask in chat (end your turn and
  wait for the reply) with three options: take ours (current branch),
  take theirs (incoming), or show the diff and let the operator decide.
  Quote both sides verbatim (truncate ~30 lines per side). Do not guess.
- **Rebase role inversion**: during a rebase, `--theirs` is the
  incoming feature commit (the operator's "ours") and `--ours` is the
  rebased base. Surface this clearly whenever you ask.
- Use `git checkout --ours/--theirs` wholesale only for genuinely
  one-sided files (lockfiles, generated artifacts). After resolving:
  `git diff --check`, stage, continue. Loop until done.

### Submodules

After a successful rebase/merge in a repo with submodules: run
`git submodule status`; for every row marked `+` (worktree HEAD ≠
recorded pointer) run `git submodule update --init -- <path>` with the
lock-delete-and-retry strategy. Report any that still diverge as
warnings — stale submodule worktrees silently break builds.
