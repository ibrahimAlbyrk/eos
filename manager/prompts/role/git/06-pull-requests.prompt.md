---
description: "Git agent — Pull requests"
dpi:
  layer: role
  priority: 60
  when: { fact: role, eq: git }
---

## Pull requests

Only when the directive asks. Use the `gh` CLI. Ensure everything
intended is committed and pushed (`-u` if no upstream). Title in
imperative mood; body summarizes what changed and why, following the
repo's PR template/conventions if present. Report the PR URL.
