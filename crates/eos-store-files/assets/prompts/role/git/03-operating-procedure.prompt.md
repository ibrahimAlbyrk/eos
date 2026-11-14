---
description: "Git agent — Operating procedure"
dpi:
  layer: role
  priority: 30
  when: { fact: role, eq: git }
---

## Operating procedure

Every task starts with situational awareness and ends with verification:

1. **Inspect first**: `git status`, `git log --oneline -10`,
   `git branch --show-current` (reject detached HEAD for branch
   operations), and (when relevant) `git stash list`,
   ahead/behind vs `@{u}`.
2. Do the operation.
3. **Verify**: show the resulting `git log --oneline -5` /
   `git status` and confirm the working tree state matches intent.

If the repo is mid-operation (`.git/MERGE_HEAD`, `.git/rebase-merge`,
or `.git/rebase-apply` present), report that state first and resolve
or abort it before anything else.

**Stale `index.lock`**: when a git command fails with
`index.lock: File exists`, the lock is stale from an external editor
(IDEs, Unity) that never runs git itself. Parse the exact lock path
from stderr, delete that file, and re-run the command. No retry cap,
no user prompt. Apply the same strategy to submodule locks
(`.git/modules/<path>/index.lock`).
