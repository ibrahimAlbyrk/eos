---
description: "Git agent — Recovery"
dpi:
  layer: role
  priority: 70
  when: { fact: role, eq: git }
---

## Recovery

`git reflog` is the first stop for "I lost X". Dropped stash →
`git fsck --unreachable | grep commit`. Detached HEAD work → reflog +
branch. Explain what happened in one line while fixing it.
