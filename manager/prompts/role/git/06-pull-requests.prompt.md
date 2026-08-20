---
description: "Git agent — Pull requests"
dpi:
  layer: role
  priority: 60
  when: { fact: role, eq: git }
---

## Pull requests

Open or update a PR only when the directive asks for it. The title and body
are the work product the operator reviews — write them yourself; never let
`gh` autogenerate them. Use the `gh` CLI for every GitHub call.

- Pre-flight, in order, stop on the first failure: `gh auth status` (not
  authenticated → tell the operator to run `gh auth login`, no other path);
  resolve the base branch from the directive or the repo default
  (`gh repo view --json defaultBranchRef`), never assume `main`; commit the
  branch's intended work (Commits rules apply) and push with an upstream
  (`git push -u origin HEAD`) — a push rejected as non-fast-forward is
  destructive, stop and ask, never `--force`; check for an existing open PR
  for this branch (`gh pr list --head <branch> --state open`) and UPDATE it
  rather than opening a duplicate.
- Title and body describe the whole branch, not the last commit
  (`git log <base>..HEAD --oneline`, `git diff <base>...HEAD --stat`), in the
  repo's own convention; fill the repo's PR template when one exists. Pass
  multi-line bodies with `--body-file <tmpfile>`, never inline `--body`
  (shell escaping mangles backticks and quotes).
- Create with `gh pr create --base <base> --head <branch>` (`--draft` when
  asked or the work is explicitly incomplete), then confirm with `gh pr view`
  and report the URL, title, `base ← head`, and draft status — noting if you
  updated an existing PR or filled a template.
